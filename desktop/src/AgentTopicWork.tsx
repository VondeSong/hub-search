import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {AgentConversation,AgentDelivery,prependConversation,type Conversation,type Evidence,type HistoricalDelivery,type Progress} from "./AgentDelivery";
import {AgentCharts,type AnalysisChart} from "./AgentCharts";
import {type SleepDatasetItem} from "./AgentSleepDatasets";
import {AgentDatasetVersions} from "./AgentDatasetVersions";
import {AgentTopicChanges} from "./AgentTopicChanges";
import {useDocumentVisible} from "./WindowVisibility";

type Anchor={kind:"note";libraryId:string;documentId:string;pageId:string|null};
type Snapshot={work:{id:string;anchor:Anchor;goal:string;state:string;revision:number;authorizationVersion:number};run:{id:string;state:string;error?:string|null}|null;recordVersion?:number;conversation?:Conversation;history?:HistoricalDelivery[];progress?:Progress|null;validity?:string;analysisArtifacts?:AnalysisChart[];sleepDatasets?:SleepDatasetItem[]};
const call=<T,>(args:Record<string,unknown>)=>invoke<T>("agent_investigation",{args});
const states:Record<string,string>={ready:"待运行",investigating:"进行中",completed:"已结束",failed:"失败",cancelled:"已停止",interrupted:"已中断",revoked:"授权已撤回",expired:"依据已过期"};

export function AgentTopicWork({workId,anchor,page,disabled,onBack,onOpenWork,onBind,changeContext}:{workId:string;anchor:Anchor;page:"成果"|"数据"|"历史";disabled:boolean;onBack:()=>void;onOpenWork:(id:string,draft?:string)=>Promise<void>;onBind?:(revision:number)=>Promise<void>;changeContext?:{topicId:string;topicRevision:number}}) {
 const visible=useDocumentVisible(),generation=useRef(0),sourceGeneration=useRef(0),alive=useRef(true),reload=useRef<()=>Promise<void>>(async()=>{});
 const [view,setView]=useState<Snapshot|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(""),[olderLoading,setOlderLoading]=useState(false);
 const [source,setSource]=useState<{excerpt:Evidence;quote:string}|null>(null),[sourceError,setSourceError]=useState(""),[sourceLoading,setSourceLoading]=useState(false);
 const sourcePanel=useRef<HTMLElement>(null),returnSource=useRef<HTMLElement|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;sourceGeneration.current++;};},[]);
 useEffect(()=>{
  let disposed=false,request=0,current:Snapshot|null=null,detach:(()=>void)|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const invalidate=()=>{current=null;generation.current++;sourceGeneration.current++;setView(null);setSource(null);setSourceError("");setSourceLoading(false);setOlderLoading(false);};
  async function read(){
   const ticket=++request,scope=generation.current;setLoading(true);setError("");
   try {
    const next=await call<Snapshot>({action:"status",id:workId});if(disposed||ticket!==request||scope!==generation.current)return;
    const a=next.work.anchor;
    if(next.work.id!==workId||a?.kind!=="note"||a.libraryId!==anchor.libraryId||a.documentId!==anchor.documentId||a.pageId!==anchor.pageId)throw new Error("原工作与专题笔记身份不一致，未显示内容");
    const unchanged=current&&current.work.revision===next.work.revision&&current.work.authorizationVersion===next.work.authorizationVersion&&current.work.state===next.work.state&&current.recordVersion===next.recordVersion&&current.validity===next.validity&&JSON.stringify(current.run)===JSON.stringify(next.run);
    if(!unchanged){invalidate();current=next;setView(next);}
   }catch(reason){if(!disposed&&ticket===request){invalidate();setError(String(reason));}}
   finally{if(!disposed&&ticket===request)setLoading(false);}
  }
  invalidate();reload.current=read;
  if(visible){
   void read();
   void listen<{workId:string;eventCategory?:string}>("agent-work-updated",event=>{
    if(disposed||event.payload.workId!==workId||event.payload.eventCategory==="publicStream")return;
    invalidate();setLoading(true);if(!timer)timer=setTimeout(()=>{timer=undefined;void read();},60);
   }).then(fn=>{if(disposed)fn();else detach=fn;}).catch(()=>{/* The visible-only refresh below also checks revoked access. */});
  }else invalidate();
  const poll=visible?setInterval(()=>void read(),30_000):undefined;
  return()=>{disposed=true;generation.current++;sourceGeneration.current++;detach?.();if(timer)clearTimeout(timer);if(poll)clearInterval(poll);};
 },[workId,anchor.libraryId,anchor.documentId,anchor.pageId,visible]);
 useEffect(()=>{if(source||sourceLoading||sourceError){sourcePanel.current?.focus();sourcePanel.current?.scrollIntoView?.({block:"nearest"});}},[source,sourceLoading,sourceError]);
 useEffect(()=>{sourceGeneration.current++;setSource(null);setSourceError("");setSourceLoading(false);},[page]);
 function closeSource(){sourceGeneration.current++;setSource(null);setSourceError("");setSourceLoading(false);if(returnSource.current?.isConnected)returnSource.current.focus();}
 async function openSource(runId:string,evidenceIndex:number,quote:string){
  if(!view||view.work.state==="revoked")return;
  const ticket=++sourceGeneration.current,scope=generation.current;returnSource.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
  setSource(null);setSourceError("");setSourceLoading(true);
  try {const next=await call<{excerpt:Evidence}>({action:"source",id:workId,runId,evidenceIndex,quote});if(alive.current&&scope===generation.current&&ticket===sourceGeneration.current)setSource({...next,quote});}
  catch(reason){if(alive.current&&scope===generation.current&&ticket===sourceGeneration.current)setSourceError(String(reason));}
  finally{if(alive.current&&scope===generation.current&&ticket===sourceGeneration.current)setSourceLoading(false);}
 }
 async function earlier(){
  const current=view,cursor=current?.conversation?.nextCursor;if(!current||!cursor||olderLoading||current.work.state==="revoked")return;
  const ticket=generation.current;setOlderLoading(true);setError("");
  try{
   const value=await call<{workId:string;workRevision:number;authorizationVersion:number;conversation:Conversation}>({action:"historyPage",id:workId,before:cursor,expectedRevision:current.work.revision,expectedAuthorizationVersion:current.work.authorizationVersion});
   if(!alive.current||generation.current!==ticket)return;
   if(value.workId!==workId||value.workRevision!==current.work.revision||value.authorizationVersion!==current.work.authorizationVersion)throw new Error("历史返回身份或授权版本不一致");
   setView(latest=>alive.current&&generation.current===ticket&&latest?.work.revision===current.work.revision&&latest.work.authorizationVersion===current.work.authorizationVersion&&latest.conversation?.nextCursor===cursor?{...latest,conversation:prependConversation(latest.conversation,value.conversation)}:latest);
  }catch(reason){if(alive.current&&generation.current===ticket)setError(String(reason));}
  finally{if(alive.current&&generation.current===ticket)setOlderLoading(false);}
 }
 const revoked=view?.work.state==="revoked",conversation=view?.conversation;
 const reports=conversation?.messages.filter(message=>message.role==="assistant"&&message.report)||[];
 const last=reports[reports.length-1],charts=view?.analysisArtifacts||[],datasets=view?.sleepDatasets||[];
 return <section className="agent-topic-work" aria-label={"专题"+page}>
  <header><h4>原工作 · {page}</h4><button type="button" onClick={onBack}>返回周期列表</button><button type="button" disabled={loading} onClick={()=>void reload.current()}>重新核对当前状态</button></header>
  {loading&&<p role="status">正在核对原工作、成果和当前授权…</p>}{error&&<p role="alert">{error}</p>}
  {view&&<><p>{view.work.goal}</p><p role="status" className="agent-note">最近尝试：{states[view.run?.state||view.work.state]||"状态待核对"}。{view.run?.error||""} {view.validity||""}</p>
   {revoked&&<p role="status">授权已撤回，成果和数据已隐藏。专题不会重新授权资料。</p>}
   {!revoked&&<><button type="button" disabled={disabled} onClick={()=>void onOpenWork(workId).catch(reason=>{if(alive.current)setError(String(reason));})}>进入原工作继续或保存（此处不执行）</button>{onBind&&<button type="button" disabled={disabled||view.work.revision===undefined} onClick={()=>void onBind(view.work.revision).catch(reason=>{if(alive.current)setError(String(reason));})}>将专题固定方法用于本期下一轮（不运行）</button>}
    {changeContext&&<AgentTopicChanges key={`${changeContext.topicId}:${changeContext.topicRevision}:${workId}:${view.work.revision}:${view.work.authorizationVersion}:${view.recordVersion}`} {...changeContext} workId={workId} workRevision={view.work.revision} authorizationVersion={view.work.authorizationVersion} disabled={disabled||view.work.state==="investigating"}/>}
    {page==="成果"&&<>{view.work.state!=="completed"&&<p className="agent-note">最近尝试尚未完成；保留成果不表示本次要求已完成。</p>}
     {last?<><p className="agent-note">最近保存的成果；有效性按原报告标注。</p><AgentConversation workId={workId} recordVersion={view.recordVersion} conversation={{messages:[last],hasEarlier:false}} revoked={false} onOpenCitation={(run,index,quote)=>void openSource(run,index,quote)}/></>:<AgentDelivery workId={workId} recordVersion={view.recordVersion} report={null} evidence={[]} progress={view.progress} history={view.history} running={view.work.state==="investigating"} revoked={false} onOpenCitation={(run,index,quote)=>void openSource(run,index,quote)}/>}
     {!last&&!view.history?.length&&<p className="agent-note">当前页尚无可读的已保存成果。可从历史读取更早记录，或进入原工作核对；不会把未完成内容当成交付。</p>}
    </>}
    {page==="数据"&&<><AgentCharts workId={workId} recordVersion={view.recordVersion} items={charts} separateSleepDatasets={datasets} revoked={false}/>{datasets.map(item=><AgentDatasetVersions key={`${workId}:${item.datasetId}:${item.revision}:${view.recordVersion}`} item={item} workId={workId} recordVersion={view.recordVersion} onCorrect={disabled||view.work.state==="investigating"?undefined:(selected,rowId)=>{const row=selected.content?.rows.find(row=>row.rowId===rowId);if(row)void onOpenWork(workId,`请核对主睡眠数据集 ${selected.datasetId} 第 ${selected.revision} 版的记录 ${rowId}（${row.eventDate||"日期未知"}，原值请从已保存版本核对）。\n我的纠正：\n\n请保留原文与历史，核对更正依据后再重算受影响成果；没有实际依据时说明限制。`).catch(reason=>{if(alive.current)setError(String(reason));});}}/>)}{!charts.length&&!datasets.length&&<p className="agent-note">尚无已保存的数据集或图表。报告文字不冒充可核对数据表。</p>}</>}
    {page==="历史"&&(conversation?<AgentConversation workId={workId} recordVersion={view.recordVersion} conversation={conversation} revoked={false} onOpenCitation={(run,index,quote)=>void openSource(run,index,quote)} onLoadEarlier={()=>void earlier()} earlierLoading={olderLoading}/>:<AgentDelivery workId={workId} recordVersion={view.recordVersion} report={null} evidence={[]} history={view.history} running={false} revoked={false} onOpenCitation={(run,index,quote)=>void openSource(run,index,quote)}/>)}
   </>}
  </>}
  {(source||sourceLoading||sourceError)&&!revoked&&<section ref={sourcePanel} tabIndex={-1} className="agent-source-preview" aria-label="专题引用原文" onKeyDownCapture={event=>{if(event.key==="Escape" && !event.nativeEvent.isComposing && !event.defaultPrevented){event.preventDefault();event.stopPropagation();closeSource();}}}>
   <header><strong>{source?.excerpt.title||"引用原文"}</strong><button type="button" onClick={closeSource}>关闭引用并返回</button></header>
   {sourceLoading?<p role="status">正在按当前授权核对原文…</p>:sourceError?<p role="alert">{sourceError}。可重新核对状态后打开。</p>:source&&<><p className="agent-note">{source.excerpt.sourcePath} · 第{source.excerpt.startChar+1}–{source.excerpt.endChar}字符{source.excerpt.truncated?"（节选）":""}</p><blockquote>{source.excerpt.content}</blockquote></>}
  </section>}
 </section>;
}
