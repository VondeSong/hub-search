import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import type {WorkSummary} from "./AgentConversationHistoryData";
import type {InsightSource} from "./InsightTypes";
import type {useInsights} from "./useInsights";

type Candidate={locator:unknown;version:unknown;title:string;snippet:string;matchStartChar?:number};
type Results={candidates:Candidate[];scopeCount:number;limitReached:boolean;unavailableCandidates:number};
const call=<T,>(args:Record<string,unknown>)=>invoke<T>("agent_investigation",{args});

export function InsightRecall({data,onOpenWork}:{data:ReturnType<typeof useInsights>;onOpenWork:(id:string,question?:string)=>void}){
 const [works,setWorks]=useState<WorkSummary[]>([]),[cursor,setCursor]=useState<unknown>(null),[work,setWork]=useState("");
 const [query,setQuery]=useState(""),[result,setResult]=useState<Results|null>(null),[error,setError]=useState("");
 const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false);
 const [source,setSource]=useState<{candidate:Candidate;excerpt:InsightSource["excerpt"]}|null>(null);
 const alive=useRef(true),ticket=useRef(0),page=useRef(0);
 async function load(before?:unknown){const current=++page.current;setLoading(true);try{const value=await data.selectWorks(before);if(alive.current&&current===page.current){setWorks(old=>before?[...old,...value.works.filter(w=>!old.some(o=>o.id===w.id))]:value.works);setCursor(value.nextCursor);}}catch(e){if(alive.current&&current===page.current)setError(String(e));}finally{if(alive.current&&current===page.current)setLoading(false);}}
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;++ticket.current;++page.current;};},[]);
 function clear(){++ticket.current;setResult(null);setSource(null);setError("");setBusy(false);}
 async function search(){const current=++ticket.current;setBusy(true);setResult(null);setSource(null);setError("");try{const value=await call<Results>({action:"insightRecall",id:work,query:query.trim()});if(alive.current&&current===ticket.current)setResult(value);}catch(e){if(alive.current&&current===ticket.current)setError(String(e));}finally{if(alive.current&&current===ticket.current)setBusy(false);}}
 async function read(candidate:Candidate,startChar=candidate.matchStartChar??0){const current=++ticket.current;setBusy(true);setSource(null);setError("");try{const excerpt=await call<InsightSource["excerpt"]>({action:"insightRecallSource",id:work,locator:candidate.locator,version:candidate.version,startChar});if(alive.current&&current===ticket.current)setSource({candidate,excerpt});}catch(e){if(alive.current&&current===ticket.current){setResult(null);setError(`${String(e)}。原文未显示，请重新查找。`);}}finally{if(alive.current&&current===ticket.current)setBusy(false);}}
 return <><p className="insights-dialog-intro">先围绕一个明确事项寻找可复用的材料。关键词匹配只是候选，不能证明关联成立或验证已经完成。</p>
  <div className="insights-picker-body insights-recall"><p className="insights-muted">只使用原事项已明确选中的 1–32 份笔记，不使用整库授权。按本机同步内容查找；检索和查看原文不会启动分析。</p>
   <form onSubmit={e=>{e.preventDefault();if(work&&query.trim()&&!busy)void search();}}><label>原事项<select aria-label="原事项" value={work} onChange={e=>{clear();setWork(e.target.value);}}><option value="">选择一个事项…</option>{works.map(w=><option key={w.id} value={w.id}>{w.goal}</option>)}</select></label>{cursor!=null&&<button type="button" disabled={loading} onClick={()=>void load(cursor)}>载入更早事项</button>}
    <label>查找关键词<input type="text" maxLength={120} value={query} placeholder="例如：验证、孔位、回忆" onChange={e=>{clear();setQuery(e.target.value);}}/></label><button type="submit" className="insights-primary" disabled={!work||!query.trim()||busy}>在已选资料中查找</button></form>
   {loading&&<p role="status">正在读取事项…</p>}{busy&&<p role="status">正在核对已选资料…</p>}{error&&<p className="insights-error" role="alert">{error}</p>}
   {result&&<><p role="status">已在 {result.scopeCount} 份已选笔记中找到 {result.candidates.length} 份候选资料。{!result.candidates.length?"可以换一个关键词；无命中不等于没有相关知识。":"请核对原文、适用条件和反例。"}</p>{result.limitReached&&<p className="insights-muted">仅显示前 10 份候选，请缩小关键词。</p>}{result.unavailableCandidates>0&&<p className="insights-muted">部分已选资料当前不可用，未参与查找。</p>}
    {!source&&result.candidates.map((candidate,index)=><article key={index}><strong>{candidate.title}</strong><p>{candidate.snippet}</p><button type="button" disabled={busy} onClick={()=>void read(candidate)}>查看原文</button></article>)}</>}
   {source&&<article aria-label="候选资料原文"><strong>{source.excerpt.title}</strong><p className="insights-muted">{source.excerpt.sourcePath} · 第 {source.excerpt.startChar+1}–{source.excerpt.endChar} / {source.excerpt.totalChars} 字符</p><blockquote>{source.excerpt.content}</blockquote><button type="button" onClick={()=>setSource(null)}>返回候选</button>{source.excerpt.startChar>0&&<button type="button" disabled={busy} onClick={()=>void read(source.candidate,0)}>从头阅读</button>}{source.excerpt.endChar<source.excerpt.totalChars&&<button type="button" disabled={busy} onClick={()=>void read(source.candidate,source.excerpt.endChar)}>继续读原文</button>}</article>}
  </div><footer><button type="button" disabled={!work} onClick={()=>onOpenWork(work,`请围绕原事项核对${query.trim()?`关键词 ${JSON.stringify(query.trim())} 所指问题`:"目前的问题"}与已有知识的关系。仅使用原事项已授权的资料，先读取原文，再说明可复用之处、适用条件和反例。区分关键词匹配、待核对解释与明确的资料陈述；核对明确对象的计划、原型验证与实机完成状态，证据不足保留未知。没有足够依据时发现可以为空；有依据的发现保留精确引用。不要自动改写来源、任务状态或已保存发现。`)}>在原事项核对</button></footer></>;
}
