"use client";
import {useState} from "react";
import {BookOpen,Plus,Search} from "lucide-react";
import {discoveryExamples,historyCandidates,type DiscoveryRecord,type DiscoverySession} from "./insight-discovery";

export function DiscoveryHistoryDemo({session,onAdd}:{session:DiscoverySession;onAdd:(id:string)=>void}){
 const [libraries,setLibraries]=useState<string[]>([]),[query,setQuery]=useState(""),[candidates,setCandidates]=useState<DiscoveryRecord[]|null>(null);
 const sample=discoveryExamples[session.scope];
 const names=[...new Set(sample.records.map(record=>record.library))];
 return <details className="id-history-lookup"><summary>在允许的历史范围中找旧资料</summary>
  <p className="id-muted">只带一份当前记录也可以开始。这里演示本机文字匹配，不调用模型；找到候选不代表它已经适用。</p>
  <fieldset><legend>这一次允许查找的示例库</legend>{names.map(name=><label key={name}><input type="checkbox" checked={libraries.includes(name)} onChange={e=>{setLibraries(old=>e.target.checked?[...old,name]:old.filter(v=>v!==name));setCandidates(null);}}/>{name}</label>)}</fieldset>
  <label className="id-history-query">补充线索词（可空）<input value={query} maxLength={120} placeholder="留空时，根据已选资料的文字找候选" onChange={e=>{setQuery(e.target.value);setCandidates(null);}}/></label>
  <button type="button" className="ip-button" disabled={!libraries.length||!session.selected.length} onClick={()=>setCandidates(historyCandidates(session,libraries,query))}><Search size={14}/>查找可能相关的旧资料</button>
  {candidates&&<section aria-label="历史资料候选"><p className="id-muted" role="status">本次找到 {candidates.length} 份候选 · 固定示例，未搜索你的库。没有结果时可以改线索词或结束。</p>{candidates.map(record=><article key={record.id}><BookOpen size={15}/><div><strong>{record.title}</strong><small>{record.library} · 文字可能相关，仍需查看原文和核对用途。</small></div><button type="button" className="ip-button" disabled={session.selected.includes(record.id)} onClick={()=>onAdd(record.id)}><Plus size={14}/>{session.selected.includes(record.id)?"已加入本次":"加入本次资料"}</button></article>)}</section>}
 </details>;
}
