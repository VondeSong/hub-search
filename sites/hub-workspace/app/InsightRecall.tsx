"use client";
import {useEffect,useState} from "react";
import {REPORT_FIXTURES} from "./insight-reports";
import {isSourceAccessible,type LedgerState} from "./insight-ledger";
import {recallFixture} from "./insight-recall";

export function InsightRecall({state,onOpenWork}:{state:LedgerState;onOpenWork:(id:string)=>void}){
 const works=[...new Map(REPORT_FIXTURES.map(r=>[r.workId,r.workTitle])).entries()];
 const [work,setWork]=useState(""),[query,setQuery]=useState(""),[searched,setSearched]=useState(false);
 const [hits,setHits]=useState<{id:string;title:string;content:string}[]>([]);
 useEffect(()=>{setHits([]);setSearched(false);},[state.revision]);
 function search(){
  setHits(recallFixture(state,work,query));setSearched(true);
 }
 return <><div className="ip-form ip-recall"><p className="ip-form-help">先围绕一个明确事项寻找可复用的材料。关键词匹配只是候选，不能证明关联成立或验证已经完成。</p><p className="ip-form-help">原型演示：仅搜索该示例事项引用的预置资料，不连接私人资料，也不调用模型。</p>
  <label>原事项<select value={work} onChange={e=>{setWork(e.target.value);setHits([]);setSearched(false);}}><option value="">选择一个事项…</option>{works.map(([id,title])=><option key={id} value={id}>{title}</option>)}</select></label>
  <label>查找关键词<input type="text" value={query} maxLength={120} placeholder="例如：验证、孔位、回忆" onChange={e=>{setQuery(e.target.value);setHits([]);setSearched(false);}}/></label>
  <button className="ip-button ip-primary" disabled={!work||!query.trim()} onClick={search}>在已选资料中查找</button>
  {searched&&<p role="status">{hits.length?`找到 ${hits.length} 份候选资料；请核对原文、适用条件和反例。`:"没有匹配资料。可以换一个关键词；无命中不等于没有相关知识。"}</p>}
  {hits.filter(h=>isSourceAccessible(h.id,state)).map(h=><article key={h.id}><strong>{h.title}</strong><details><summary>查看原文</summary><blockquote>{h.content}</blockquote></details></article>)}
 </div><footer className="ip-dialog-footer"><button className="ip-button" disabled={!work} onClick={()=>onOpenWork(work)}>在原事项核对</button></footer></>;
}
