import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import type {Insight,InsightSource} from "./InsightTypes";
import {FindingMarkdown,InsightFindingText} from "./InsightFindingText";

export function InsightInlineHistory({item,generation,onReadSource}:{item:Insight;generation?:number;onReadSource:(source:InsightSource["excerpt"])=>void}){
 const [value,setValue]=useState<Insight|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(false);
 const sequence=useRef(0),opened=useRef(false);
 async function read(revision?:number){
  const ticket=++sequence.current;setValue(null);setLoading(true);setError("");
  try{const v=await invoke<Insight>("agent_investigation",{args:{action:"insightDetail",insightId:item.id,...(revision?{revision}:{})}});if(ticket===sequence.current)setValue(v);}
  catch(e){if(ticket===sequence.current)setError(String(e));}
  finally{if(ticket===sequence.current)setLoading(false);}
 }
 useEffect(()=>{++sequence.current;setValue(null);if(opened.current)void read();return()=>{++sequence.current;};},[item.id,item.headRevision,generation]);
 return <details className="idd-history" onToggle={e=>{opened.current=e.currentTarget.open;if(opened.current)void read();else{++sequence.current;setValue(null);setLoading(false);}}}><summary>查看判断与复核历史</summary>
  {loading&&<p role="status">正在核对历史的访问范围…</p>}{error&&<p role="alert">{error}</p>}
  {value&&<><label>查看内容版本 <select aria-label="本流程的历史版本" value={value.contentRevision??value.headRevision} onChange={e=>void read(Number(e.target.value))}>{Array.from({length:value.headRevision},(_,i)=>i+1).reverse().map(n=><option key={n} value={n}>版本 {n}{n===value.headRevision?"（当前）":""}</option>)}</select></label>
   {value.validity==="review"&&<p role="status">此版本待复核；下方是当时保存的记录。</p>}
   {value.snapshot?<article><InsightFindingText text={value.snapshot.text}/>{value.snapshot.reviewOutcome&&<section><h4>{value.snapshot.reviewOutcome.kind==="maintain"?"本次维持原判断":"本次采用补充修订"}</h4><FindingMarkdown text={value.snapshot.reviewOutcome.comparison}/><p>对照版本 {value.snapshot.reviewOutcome.previousRevision}，之前的版本仍保留。</p></section>}<div className="idd-evidence">{value.snapshot.sourceCitations.filter((source,i,all)=>all.findIndex(s=>JSON.stringify([s.excerpt.locator,s.excerpt.version,s.excerpt.startChar,s.excerpt.endChar])===JSON.stringify([source.excerpt.locator,source.excerpt.version,source.excerpt.startChar,source.excerpt.endChar]))===i).map((source,i)=><button type="button" key={i} onClick={()=>onReadSource(source.excerpt)}>查看此次依据 · {source.excerpt.title}</button>)}</div></article>:<p>此版本当前不可访问，正文已隐藏。</p>}
  </>}
 </details>;
}
