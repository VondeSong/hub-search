"use client";
import {useEffect,useState} from "react";
import {REPORT_FIXTURES} from "./insight-reports";
import {isSourceAccessible,type LedgerState} from "./insight-ledger";
import {recallFixture} from "./insight-recall";

export function InsightRecall({state,onOpenWork}:{state:LedgerState;onOpenWork:(id:string,question?:string)=>void}){
 const works=[...new Map(REPORT_FIXTURES.map(r=>[r.workId,r.workTitle])).entries()];
 const [work,setWork]=useState(""),[query,setQuery]=useState(""),[searched,setSearched]=useState(false);
 const [hits,setHits]=useState<{id:string;title:string;content:string}[]>([]);
 const [mode,setMode]=useState<"keyword"|"semantic"|"status">("keyword");
 useEffect(()=>{setHits([]);setSearched(false);},[state.revision]);
 function search(){
  setHits(recallFixture(state,work,query));setSearched(true);
 }
 return <><div className="ip-form ip-recall"><p className="ip-form-help">先围绕一个明确事项寻找可复用的材料。关键词匹配只是候选，不能证明关联成立或验证已经完成。</p><p className="ip-form-help">原型演示：仅搜索该示例事项引用的预置资料，不连接私人资料，也不调用模型。</p>
  <label>原事项<select value={work} onChange={e=>{setWork(e.target.value);setHits([]);setSearched(false);}}><option value="">选择一个事项…</option>{works.map(([id,title])=><option key={id} value={id}>{title}</option>)}</select></label>
  <label>核对方式<select value={mode} onChange={e=>{setMode(e.target.value as typeof mode);setHits([]);setSearched(false);}}><option value="keyword">关键词定位</option><option value="semantic">按含义寻找可复用知识</option><option value="status">核对明确任务与笔记的状态差异</option></select></label>
  <label>{mode==="keyword"?"查找关键词":"这次想核对什么"}<input type="text" value={query} maxLength={1200} placeholder="例如：怎样区分纸面验证和实际完成" onChange={e=>{setQuery(e.target.value);setHits([]);setSearched(false);}}/></label>
  {mode==="keyword"?<button className="ip-button ip-primary" disabled={!work||!query.trim()} onClick={search}>在已选资料中查找</button>:<><p className="ip-form-help">{mode==="semantic"?"桌面由原助手在明确选定的资料内按含义交叉核对，保留原文、适用条件和实际覆盖。此处仅演示入口，不伪造模型已经核对的候选。":"桌面需要同时明确选择任务对象和说明笔记，区分计划、纸面验证、实际完成和未知；只提出待核对差异，不自动改任务。"}</p><button className="ip-button ip-primary" disabled={!work||!query.trim()} onClick={()=>onOpenWork(work,`${mode==="semantic"?"请按含义寻找可复用知识":"请核对明确任务与笔记的完成状态差异"}：${query}。只用本次授权，读取两侧原文、保留精确引用和不确定性，不写入来源或任务。当前是交互演示，不声称读取真实资料。`)}>在原事项准备核对</button></>}
  {searched&&<p role="status">{hits.length?`找到 ${hits.length} 份候选资料；请核对原文、适用条件和反例。`:"没有匹配资料。可以换一个关键词；无命中不等于没有相关知识。"}</p>}
  {hits.filter(h=>isSourceAccessible(h.id,state)).map(h=><article key={h.id}><strong>{h.title}</strong><details><summary>查看原文</summary><blockquote>{h.content}</blockquote></details></article>)}
 </div><footer className="ip-dialog-footer"><button className="ip-button" disabled={!work} onClick={()=>onOpenWork(work)}>在原事项核对</button></footer></>;
}
