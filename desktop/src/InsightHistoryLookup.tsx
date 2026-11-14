import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {BookOpen,Plus,Search} from "lucide-react";
import {materialKey,type AgentMaterial,type NoteLocator} from "./AgentMaterials";

type Candidate=AgentMaterial&{version:unknown;snippet:string;matchedTerms:string[]};
type Result={candidates:Candidate[];queries:string[];limitReached:boolean;unavailableCandidates:number};
const call=<T,>(args:Record<string,unknown>)=>invoke<T>("agent_investigation",{args});
export function InsightHistoryLookup({notes,disabled,onAdd,onPreview}:{notes:NoteLocator[];disabled:boolean;onAdd:(note:AgentMaterial)=>void;onPreview:(note:{locator:NoteLocator;version:unknown})=>void}){
 const [libraries,setLibraries]=useState<{libraryId:string;name:string}[]>([]),[allowed,setAllowed]=useState<string[]>([]),[query,setQuery]=useState("");
 const [result,setResult]=useState<Result|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const ticket=useRef(0),alive=useRef(true),loaded=useRef(false);
 const key=JSON.stringify(notes);
 function invalidate(){++ticket.current;setResult(null);setError("");setBusy(false);}
 useEffect(()=>{invalidate();},[key,disabled]);
 useEffect(()=>{alive.current=true;let disposed=false;const stops:(()=>void)[]=[];
  for(const event of ["library-registry-updated","library-runtime-updated","data-portability-updated"]){void listen(event,()=>{if(!disposed){invalidate();loaded.current=false;void catalog();}}).then(stop=>disposed?stop():stops.push(stop));}
  return()=>{disposed=true;alive.current=false;++ticket.current;stops.forEach(stop=>stop());};
 },[]);
 async function catalog(){if(loaded.current)return;const seq=++ticket.current;setBusy(true);setError("");try{const value=await call<{libraries:typeof libraries}>({action:"insightHistoryLibraries"});if(alive.current&&seq===ticket.current){setLibraries(value.libraries);setAllowed(old=>old.filter(id=>value.libraries.some(l=>l.libraryId===id)));loaded.current=true;}}catch(e){if(alive.current&&seq===ticket.current){setLibraries([]);setAllowed([]);setError(String(e));}}finally{if(alive.current&&seq===ticket.current)setBusy(false);}}
 async function search(){const seq=++ticket.current;setBusy(true);setResult(null);setError("");try{const value=await call<Result>({action:"insightHistorySearch",libraryIds:allowed,notes,query});if(alive.current&&seq===ticket.current)setResult(value);}catch(e){if(alive.current&&seq===ticket.current)setError(String(e));}finally{if(alive.current&&seq===ticket.current)setBusy(false);}}
 async function add(candidate:Candidate){const seq=++ticket.current;setBusy(true);setError("");try{await call({action:"insightDiscoveryPreview",locator:candidate.locator,version:candidate.version,startChar:0});if(alive.current&&seq===ticket.current)onAdd(candidate);}catch(e){if(alive.current&&seq===ticket.current){setResult(null);setError(String(e));}}finally{if(alive.current&&seq===ticket.current)setBusy(false);}}
 return <details className="idd-history-lookup" onToggle={e=>{if(e.target===e.currentTarget&&e.currentTarget.open)void catalog();}}><summary>在允许的历史范围中找旧资料</summary>
  <p className="insights-muted">只带一份当前记录也可以查找。本次只在你勾选的本机库做文字匹配，不调用模型；找到候选不代表已经适用。加入后只有选定的资料参与分析。</p>
  <fieldset disabled={disabled||busy}><legend>这一次允许查找的库</legend>{libraries.map(l=><label key={l.libraryId}><input type="checkbox" checked={allowed.includes(l.libraryId)} onChange={e=>{invalidate();setAllowed(old=>e.target.checked?[...old,l.libraryId]:old.filter(id=>id!==l.libraryId));}}/>{l.name}</label>)}</fieldset>
  {!libraries.length&&!busy&&<button type="button" disabled={disabled} onClick={()=>void catalog()}>读取可用资料库</button>}
  <label className="idd-history-query">补充线索词（可空）<input aria-label="历史资料线索词" value={query} disabled={disabled||busy} maxLength={120} placeholder="留空时，根据已选资料的文字找候选" onChange={e=>{invalidate();setQuery(e.target.value);}}/></label>
  <button type="button" disabled={disabled||busy||!allowed.length||!notes.length} onClick={()=>void search()}><Search size={14}/>{busy?"正在核对本机资料…":"查找可能相关的旧资料"}</button>
  {result&&<section aria-label="历史资料候选"><p className="insights-muted" role="status">本次找到 {result.candidates.length} 份候选 · 线索：{result.queries.join("、")||"未提取到线索"}。{result.limitReached?"达到候选上限，仍可能遗漏；":""}本地缓存，未核对远端最新内容。{result.unavailableCandidates?`${result.unavailableCandidates}次候选读取不可用。`:""}{!result.candidates.length&&"可以改线索词、换范围或结束；没有结果不表示不存在关联。"}</p>{result.candidates.map(candidate=><article key={materialKey(candidate.locator)}><BookOpen size={15}/><div><strong>{candidate.title}</strong><small>{candidate.libraryName} · 命中文字：{candidate.matchedTerms.join("、")}，用途仍待核对。</small><p>{candidate.snippet}</p></div><footer><button type="button" disabled={disabled||busy} onClick={()=>onPreview(candidate)}>查看原文</button><button type="button" disabled={disabled||busy||notes.length>=32} onClick={()=>void add(candidate)}><Plus size={14}/>加入本次资料</button></footer></article>)}</section>}
  {error&&<p className="insights-error" role="alert">{error}。请重新查找。</p>}
 </details>;
}
