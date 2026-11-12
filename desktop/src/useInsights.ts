import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {useCallback,useEffect,useRef,useState} from "react";
import {userProfileStorage} from "./UserProfileStorage";
import type {Insight,InsightCandidate,InsightCandidates,InsightDelivery,InsightList,InsightOrigin,InsightSource} from "./InsightTypes";
import type {WorkSummary} from "./AgentConversationHistoryData";
import type {InvestigationLocator} from "./AgentInvestigation";

const call=<T,>(args:Record<string,unknown>)=>invoke<T>("agent_investigation",{args});
const pendingKey="hub.insights.pending-write.v1";
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
type Result={item:Insight;committed?:boolean;replayed?:boolean;operation?:Record<string,unknown>};
type Pending=Record<string,unknown> & {operationId:string};

export function useInsights(){
 const [items,setItems]=useState<Insight[]>([]),[detail,setDetail]=useState<Insight|null>(null);
 const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [generation,setGeneration]=useState(0);
 const [more,setMore]=useState<InsightList["nextBefore"]>(null);
 const [pendingChecked,setPendingChecked]=useState(false);
 const [unresolved,setUnresolved]=useState<Pending|null>(()=>{try{return JSON.parse(userProfileStorage.getItem(pendingKey)||"null") as Pending|null;}catch{return null;}});
 const alive=useRef(true),sequence=useRef(0),accessEpoch=useRef(0),detailSequence=useRef(0),lock=useRef(false),detailId=useRef<string|null>(null);
 detailId.current=detail?.id??null;
 const accept=useCallback((item:Insight)=>{if(!alive.current)return;setItems(old=>{const at=old.findIndex(v=>v.id===item.id);return at<0?[item,...old]:old.map(v=>v.id===item.id?item:v);});setDetail(old=>old?.id===item.id?item:old);},[]);
 const refresh=useCallback(async(append=false)=>{
  const ticket=++sequence.current;setLoading(true);
  try{
   const result=await call<InsightList>({action:"insightList",...(append&&more?{before:more}:{})});
   if(!alive.current||ticket!==sequence.current)return;
   setItems(old=>append?[...old,...result.items.filter(v=>!old.some(o=>o.id===v.id))]:result.items);setMore(result.nextBefore??null);
   if(detailId.current){const selectedId=detailId.current,detailTicket=detailSequence.current;const value=await call<Insight>({action:"insightDetail",insightId:selectedId});if(alive.current&&ticket===sequence.current&&detailTicket===detailSequence.current)setDetail(value);}
  }catch(e){if(alive.current&&ticket===sequence.current){setError(message(e));setItems([]);setDetail(null);}}
  finally{if(alive.current&&ticket===sequence.current)setLoading(false);}
 },[more]);
 const refreshRef=useRef(refresh);refreshRef.current=refresh;
 useEffect(()=>{
  alive.current=true;void refreshRef.current();let unlisten:(()=>void)[]=[];let disposed=false;let timer:ReturnType<typeof setTimeout>|undefined;
  const invalidate=()=>{++accessEpoch.current;++sequence.current;++detailSequence.current;setGeneration(n=>n+1);setItems([]);setDetail(null);clearTimeout(timer);timer=setTimeout(()=>void refreshRef.current(),150);};
  window.addEventListener("focus",invalidate);
  for(const name of ["agent-work-updated","library-registry-updated","library-runtime-updated","task-list-updated","task-sync-updated","data-portability-updated"]){void listen<{eventCategory?:string}>(name,event=>{if(disposed||event.payload?.eventCategory==="publicStream")return;invalidate();}).then(stop=>{if(disposed)stop();else unlisten.push(stop);}).catch(()=>{if(!disposed)setError("无法订阅资料变化；请用核对按钮读取当前依据。");});}
  const onVisible=()=>{if(document.visibilityState==="visible")invalidate();};document.addEventListener("visibilitychange",onVisible);
  return()=>{disposed=true;alive.current=false;++sequence.current;clearTimeout(timer);unlisten.forEach(f=>f());window.removeEventListener("focus",invalidate);document.removeEventListener("visibilitychange",onVisible);};
 },[]);
 const open=useCallback(async(id:string,revision?:number)=>{
  const ticket=++detailSequence.current,epoch=accessEpoch.current;
  try{const value=await call<Insight>({action:"insightDetail",insightId:id,...(revision?{revision}:{})});if(alive.current&&ticket===detailSequence.current&&epoch===accessEpoch.current){setDetail(value);setError("");}return value;}
  catch(e){if(alive.current&&ticket===detailSequence.current&&epoch===accessEpoch.current){setError(message(e));setDetail(null);}throw e;}
 },[]);
 const execute=useCallback(async(args:Record<string,unknown>,retry?:Pending)=>{
  if(unresolved&&!retry)throw new Error("请先核对上一次操作的提交结果");
  if(lock.current)throw new Error("上一项操作尚未结束");lock.current=true;setBusy(true);setError("");
  const epoch=accessEpoch.current;
  const pending:Pending=retry??{...args,operationId:crypto.randomUUID()};
  userProfileStorage.setItem(pendingKey,JSON.stringify(pending));setUnresolved(pending);setPendingChecked(false);
  try{const result=await call<Result>(pending);if(alive.current){if(epoch===accessEpoch.current)accept(result.item);setUnresolved(null);}userProfileStorage.removeItem(pendingKey);
   if(detailId.current===result.item.id){try{const fresh=await call<Insight>({action:"insightDetail",insightId:result.item.id});if(alive.current&&epoch===accessEpoch.current)setDetail(fresh);}catch(e){if(alive.current){setDetail(null);setError(`操作已提交，详情需重新读取：${message(e)}`);}}}
   return result;}
  catch(e){if(alive.current)setError(`${message(e)}。操作记录已保留，可先核对提交结果。`);throw e;}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 },[accept,unresolved]);
 const inspectPending=useCallback(async()=>{
  if(!unresolved)return;setBusy(true);const epoch=accessEpoch.current;
  try{const v=await call<{committed:boolean;item?:Insight}>({action:"insightOperation",operationId:unresolved.operationId});if(v.committed&&v.item){if(epoch===accessEpoch.current)accept(v.item);userProfileStorage.removeItem(pendingKey);setUnresolved(null);setError("");}else{setPendingChecked(true);setError("未找到该操作的提交记录；可按原请求重试。");}}
  catch(e){setError(message(e));}finally{setBusy(false);}
 },[unresolved,accept]);
 const selectWorks=(before?:unknown)=>call<{works:WorkSummary[];nextCursor:unknown}>({action:"list",anchor:null,...(before?{before}:{})});
 const deliveries=(id:string,beforeRecordId?:string)=>call<{items:InsightDelivery[];nextBeforeRecordId?:string|null}>({action:"insightDeliveries",id,...(beforeRecordId?{beforeRecordId}:{})});
 const candidates=(id:string,deliveryRecordId:string)=>call<InsightCandidates>({action:"insightCandidates",id,deliveryRecordId});
 const saveCandidate=(origin:InsightOrigin,candidate:InsightCandidate,target?:Insight,feedbackIds:string[]=[],contextEvidenceIds:string[]=[])=>execute({action:target?"insightUpdate":"insightImport",id:origin.workId,...(target?{insightId:target.id,expectedRevision:target.rowRevision}:{}),deliveryRecordId:origin.deliveryRecordId,deliveryHash:origin.deliveryHash,findingPointer:candidate.findingPointer,confirmDependencies:true,feedbackIds,confirmFeedbackHandled:feedbackIds.length>0,contextEvidenceIds});
 const change=(item:Insight,action:string,fields:Record<string,unknown>={})=>execute({action,insightId:item.id,expectedRevision:item.rowRevision,...fields});
 const source=(item:Insight,index:number)=>call<InsightSource>({action:"insightSource",insightId:item.id,revision:item.contentRevision??item.headRevision,sourceIndex:index});
 const runReview=async(item:Insight,feedbackIds:string[],onOpenWork:(id:string)=>void)=>{
  const saved=await change(item,"insightContinue",{feedbackIds});onOpenWork(item.workId);
  setBusy(true);try{await call({action:"resume",id:item.workId,mode:"quick"});await refreshRef.current();}
  catch(e){setError(`本次核对未完成：${message(e)}。原发现与反馈已保留，请在原事项查看实际状态。`);}
  finally{if(alive.current)setBusy(false);}return saved;
 };
 const discardPending=()=>{if(!pendingChecked)return;userProfileStorage.removeItem(pendingKey);setUnresolved(null);setError("");void refreshRef.current();};
 const closeDetail=()=>{++detailSequence.current;setDetail(null);};
 return {generation,items,detail,closeDetail,loading,busy,error,setError,more,refresh,open,execute,unresolved,pendingChecked,discardPending,inspectPending,retryPending:()=>unresolved?execute(unresolved,unresolved):Promise.resolve(),selectWorks,deliveries,candidates,saveCandidate,change,source,runReview};
}

export function useInsightWork(workId:string){
 const [source,setSource]=useState<{id:string;anchor:InvestigationLocator|null}|null>(null),[error,setError]=useState("");
 useEffect(()=>{let active=true;setSource(null);setError("");void call<{work:{id:string;anchor?:InvestigationLocator|null}}>({action:"status",id:workId}).then(v=>{if(active)setSource({id:v.work.id,anchor:v.work.anchor??null});}).catch(e=>{if(active)setError(message(e));});return()=>{active=false;};},[workId]);
 return {source,error};
}
