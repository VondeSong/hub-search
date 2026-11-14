import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {ArrowLeft,ArrowRight,BookOpen,Check,GitBranch,Plus,RefreshCw,Sparkles} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {renderableCraftMarkdown} from "./CraftDisplayMarkdown";
import {AgentMaterials,type AgentMaterial} from "./AgentMaterials";
import {canRunMode,lifecycleRequest,type Lifecycle} from "./AgentLifecycle";
import {getCodexAccountSnapshot,refreshCodexAccounts} from "./CodexAccounts";
import {userProfileStorage} from "./UserProfileStorage";
import type {Insight,InsightCandidates,InsightCandidate,InsightSource} from "./InsightTypes";
import type {useInsights} from "./useInsights";
import {InsightMethods} from "./InsightMethods";
import "./InsightDiscovery.css";

const call=<T,>(args:Record<string,unknown>)=>invoke<T>("agent_investigation",{args});
const LAST="hub.insights.discovery.last.v1",PENDING="hub.insights.discovery.prepare.v1";
type Discovery={workId:string;workRevision:number;config:{question:string;targetInsightId?:string;targetRevision?:number;previousText:string};sources:{title:string;path:string;locator:unknown;version:unknown}[];results:InsightCandidates|null};
type Status={work:{id:string;revision:number;state:string;report?:{summary:string;prose?:{markdown:string}}|null};runActive?:boolean;run?:{error?:string}|null;lifecycle?:Lifecycle;assistantOptions?:{model?:{provider?:string}};modelSelection?:{provider?:string}};
export async function startDiscoveryRun(id:string,status:Status){
 if(!status.lifecycle||!canRunMode(status.lifecycle,"quick"))throw Error("当前分析不能开始，请查看原分析的额度或待处理结果");
 let codexScopeId:string|undefined;
 if((status.assistantOptions?.model?.provider??status.modelSelection?.provider??"codex")==="codex"){
  if(!getCodexAccountSnapshot().loaded||getCodexAccountSnapshot().loading)await refreshCodexAccounts();
  codexScopeId=getCodexAccountSnapshot().current?.scopeId;if(!codexScopeId)throw Error("当前 Codex 账号不可用，请在助手设置中刷新登录状态");
 }
 if(status.lifecycle.requiresExplicitResume&&!status.lifecycle.canResume)throw Error("这次分析还有待核对结果，请先打开原分析处理");
 await call({action:status.lifecycle.requiresExplicitResume?"resume":"respond",id,mode:"quick",...(status.lifecycle.requiresExplicitResume?lifecycleRequest(status.lifecycle,crypto.randomUUID()):{}),...(codexScopeId?{codexScopeId}:{})});
}
export function InsightDiscovery({data,target,onOpenWork,onView}:{data:ReturnType<typeof useInsights>;target?:Insight;onOpenWork:(id:string)=>void;onView:(item:Insight)=>void}){
 const [id,setId]=useState(target?.workId??userProfileStorage.getItem(LAST)??"");
 const [question,setQuestion]=useState(target?"这些新记录是否影响原判断？请说明应该维持还是调整，以及依据。":"");
 const [materials,setMaterials]=useState<AgentMaterial[]>([]),[bundle,setBundle]=useState<Discovery|null>(null),[status,setStatus]=useState<Status|null>(null);
 const [inherited,setInherited]=useState<{title:string;locator:unknown;sourcePath:string}[]>([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState(""),[source,setSource]=useState<InsightSource["excerpt"]|null>(null);
 const [saved,setSaved]=useState<Record<string,Insight>>({}),[targetItem,setTargetItem]=useState(target),[checked,setChecked]=useState<Record<string,boolean>>({});
 const [pendingPreparation,setPendingPreparation]=useState(false),[previewing,setPreviewing]=useState(false),[showAll,setShowAll]=useState(false);
 const alive=useRef(true),request=useRef(0),locked=useRef(false),pending=useRef<Record<string,unknown>|null>(null),currentId=useRef(id);
 const restoreQuestion=useRef(!target);
 const currentTarget=useRef(targetItem);currentTarget.current=targetItem;
 currentId.current=id;
 useEffect(()=>{try{pending.current=JSON.parse(userProfileStorage.getItem(PENDING)||"null");setPendingPreparation(!!pending.current);}catch{}},[]);
 async function refresh(workId:string){
  const ticket=++request.current;
  try{
   const [next,work]=await Promise.all([call<Discovery>({action:"insightDiscoveryRead",id:workId}),call<Status>({action:"status",id:workId})]);
   const targetId=currentTarget.current?.id??next.config.targetInsightId;
   const restored=targetId?await call<Insight>({action:"insightDetail",insightId:targetId}):null;
   if(!alive.current||currentId.current!==workId||ticket!==request.current)return;
   setBundle(targetId&&next.config.targetInsightId!==targetId?null:next);setStatus(work);if(restored)setTargetItem(restored);setInherited(next.sources.map(s=>({title:s.title,locator:s.locator,sourcePath:s.path})));if(restoreQuestion.current){setQuestion(next.config.question);restoreQuestion.current=false;}setError("");
  }catch(e){if(alive.current&&ticket===request.current){setBundle(null);setSource(null);setStatus(null);setInherited([]);setError(String(e));}}
 }
 useEffect(()=>{
  alive.current=true;let disposed=false;const stops:(()=>void)[]=[];
  if(id){
   if(target){void Promise.all([call<Status>({action:"status",id}),call<{sources:typeof inherited}>({action:"insightAnalysisScope",id})]).then(([v,s])=>{if(!disposed){setStatus(v);setInherited(s.sources);}},e=>{if(!disposed){setError(String(e));setTargetItem(old=>old?{...old,snapshot:undefined}:old);}});}
   else void refresh(id);
  }
  for(const event of ["library-registry-updated","library-runtime-updated","data-portability-updated"]){void listen(event,()=>{if(disposed)return;setBundle(null);setSource(null);setStatus(null);setInherited([]);setTargetItem(old=>old?{...old,snapshot:undefined}:old);setChecked({});if(currentId.current)void refresh(currentId.current);}).then(stop=>disposed?stop():stops.push(stop));}
  const focus=()=>{setSource(null);setChecked({});if(currentId.current)void refresh(currentId.current);};window.addEventListener("focus",focus);
  return()=>{alive.current=false;disposed=true;++request.current;stops.forEach(stop=>stop());window.removeEventListener("focus",focus);};
 },[]);
 useEffect(()=>{if(!id||(!busy&&!status?.runActive&&!status?.lifecycle?.activeRunId))return;let stopped=false;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{await refresh(id);if(!stopped)timer=setTimeout(()=>void poll(),2000);};timer=setTimeout(()=>void poll(),2000);return()=>{stopped=true;clearTimeout(timer);};},[id,busy,status?.runActive,status?.lifecycle?.activeRunId]);
 useEffect(()=>setShowAll(false),[bundle?.results?.origin.deliveryRecordId]);
 const running=!!status?.runActive||!!status?.lifecycle?.activeRunId;
 async function start(){
  if(locked.current||data.unresolved)return;locked.current=true;setBusy(true);setError("");setSource(null);setChecked({});
  try{
   const q=question.trim()||"从这些资料中找出当前可用的旧经验、值得注意的联系或变化，说明条件与未知。";
   const current=id?await call<Status>({action:"status",id}):null;
   const args={action:"insightDiscoveryPrepare",id,expectedRevision:current?.work.revision,question:q,notes:materials.map(m=>m.locator),...(targetItem?{targetInsightId:targetItem.id,targetRevision:targetItem.rowRevision}:{})};
   const old=pending.current;const {operationId:_,expectedRevision:__,...oldRequest}=old??{};const {expectedRevision:___,...identity}=args;
   if(old&&JSON.stringify(oldRequest)!==JSON.stringify(identity))throw Error("请先核对上次准备的结果，再开始不同的分析");
   if(!old)pending.current={...args,operationId:crypto.randomUUID()};
   userProfileStorage.setItem(PENDING,JSON.stringify(pending.current));
   setPendingPreparation(true);await completePreparation();
  }catch(e){if(alive.current)setError(String(e));}finally{locked.current=false;if(alive.current)setBusy(false);}
 }
 async function completePreparation(){
  if(!pending.current)return;
  const prepared=await call<Discovery>(pending.current);
  if(!alive.current)return;
  currentId.current=prepared.workId;setId(prepared.workId);setBundle(prepared);setMaterials([]);setSaved({});
  userProfileStorage.setItem(LAST,prepared.workId);userProfileStorage.removeItem(PENDING);pending.current=null;setPendingPreparation(false);
  if(!prepared.results)await run(prepared.workId);else await refresh(prepared.workId);
 }
 async function run(workId:string){
  const value=await call<Status>({action:"status",id:workId});if(alive.current)setStatus(value);
  if(value.runActive||value.lifecycle?.activeRunId)return;
  await startDiscoveryRun(workId,value);await refresh(workId);
 }
 async function readSource(value:{locator:unknown;version?:unknown;startChar?:number},startChar=value.startChar??0,preview=false){
  const ticket=++request.current;setSource(null);setPreviewing(preview);
  try{const result=await call<InsightSource["excerpt"]>({action:preview?"insightDiscoveryPreview":"insightDiscoverySource",id,locator:value.locator,version:value.version,startChar});if(alive.current&&ticket===request.current)setSource(result);}catch(e){if(alive.current&&ticket===request.current){setBundle(null);setStatus(null);setInherited([]);setTargetItem(old=>old?{...old,snapshot:undefined}:old);setChecked({});setError(String(e));}}
 }
 async function save(candidate:InsightCandidate,outcome?:"maintain"|"revise"){
  if(!bundle?.results||!checked[candidate.findingPointer]||locked.current)return;locked.current=true;setBusy(true);setError("");
  try{
   const result=await data.saveCandidate(bundle.results.origin,candidate,targetItem,[],bundle.results.contextOptions?.map(v=>v.evidenceId)??[],outcome);
   if(alive.current){setSaved(old=>({...old,[candidate.findingPointer]:result.item}));if(targetItem)setTargetItem(result.item);}
  }catch(e){if(alive.current)setError(String(e));}finally{locked.current=false;if(alive.current)setBusy(false);}
 }
 function fresh(){++request.current;currentId.current="";setId("");setTargetItem(undefined);setBundle(null);setStatus(null);setInherited([]);setMaterials([]);setQuestion("");setSource(null);setSaved({});setChecked({});userProfileStorage.removeItem(LAST);setError("");}
 const results=bundle?.results;
 const reviewing=!!bundle?.config.targetInsightId;
 function follow(item:Insight){setTargetItem(item);setBundle(null);setSaved({});setChecked({});setMaterials([]);setQuestion("这些后续记录是否影响原判断？请说明维持还是调整，以及依据。");}
 return <div className="insight-discovery-flow">
  <p className="idd-intro"><Sparkles size={15}/>使用本机已同步的真实资料；点击开始后调用当前助手模型。</p>
  {pendingPreparation&&!busy&&<div className="idd-progress" role="status"><p>上次准备的结果需要核对；将按原问题与原资料恢复，不重复创建分析。</p><button type="button" onClick={()=>{setBusy(true);void completePreparation().catch(e=>setError(String(e))).finally(()=>setBusy(false));}}>核对上次准备并继续</button></div>}
  {source?<section className="idd-source"><button type="button" onClick={()=>{++request.current;setSource(null);}}> <ArrowLeft size={14}/>返回发现</button><h3>{source.title}</h3><p className="insights-muted">{source.sourcePath} · 第{source.startChar+1}–{source.endChar} / {source.totalChars}字符</p><div className="idd-source-text"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{img:({alt})=><span>［图片：{alt||"未读取"}］</span>,a:({children})=><span>{children}</span>}}>{source.facts?.provider==="craft"?renderableCraftMarkdown(source.content):source.content}</ReactMarkdown></div><details><summary>逐字核对原文</summary><blockquote>{source.content}</blockquote></details>{source.startChar>0&&<button type="button" onClick={()=>void readSource(source,0,previewing)}>从头阅读</button>}{source.endChar<source.totalChars&&<button type="button" onClick={()=>void readSource(source,source.endChar,previewing)}>继续读原文</button>}</section>:<>
   {id&&<button type="button" disabled={busy||running} onClick={fresh}> <Plus size={14}/>另开始一次发现</button>}
   {targetItem&&<section className="idd-original"><p className="idd-kicker">原判断 · 历史保留</p><ReactMarkdown remarkPlugins={[remarkGfm]} components={{img:()=>null,a:({children})=><span>{children}</span>}}>{bundle?.config.previousText||targetItem.snapshot?.text||"当前来源不可访问"}</ReactMarkdown></section>}
   <label className="idd-question">{targetItem?"这次要核对什么":"当前关心什么"}<textarea aria-label="发现问题" rows={2} maxLength={1200} disabled={busy||running} value={question} onChange={e=>setQuestion(e.target.value)} placeholder="例如：这些旧经验能怎样帮助目前的工作？也可以留空，开放探索。"/></label>
   {!!inherited.length&&<details className="idd-scope"><summary>继续使用的 {inherited.length} 份资料</summary>{inherited.map((s,i)=><p key={i}>{s.title}<small> · {s.sourcePath}</small></p>)}</details>}
   <details className="idd-materials" open={!bundle&&!targetItem}><summary>{id?"加入后续本地记录":"这次允许使用哪些本地资料"}{materials.length?` · 已选 ${materials.length} 份`:""}</summary><AgentMaterials onPreview={note=>void readSource({locator:note.locator},0,true)} description="选中的笔记只用于这次发现，不授权整个资料库。" embedded hideFooter selected={materials} retained={inherited.map(s=>s.locator) as AgentMaterial["locator"][]} disabled={busy||running} onChange={setMaterials}/></details>
   <div className="idd-start"><p className="insights-muted">每轮只读明确选中的1–32份资料。保存、查看和展开原文不启动模型；本次不启用持续观察。</p><button type="button" className="insights-primary" disabled={busy||running||(!materials.length&&!inherited.length)||!!data.unresolved} onClick={()=>void start()}>{busy||running?"正在核对…":targetItem?"核对这次变化":id?"结合新记录再发现":"开始发现"}<ArrowRight size={15}/></button></div>
   {(busy||running)&&<div className="idd-progress" role="status"><RefreshCw size={15}/>正在读取资料和分析，结果会直接显示在这里。<button type="button" disabled={!status?.lifecycle||!running} onClick={()=>{if(status?.lifecycle)void call({action:"cancel",id,...lifecycleRequest(status.lifecycle,crypto.randomUUID())}).then(()=>refresh(id)).catch(e=>setError(String(e)));}}>停止本轮</button></div>}
   {id&&!running&&!busy&&!results&&bundle&&<div className="idd-progress"><p>尚未得到可读取的本轮成果。可以查看实际状态，或明确开始下一轮。</p><button type="button" onClick={()=>void refresh(id)}>核对运行状态</button><button type="button" onClick={()=>{setBusy(true);void run(id).catch(e=>setError(String(e))).finally(()=>setBusy(false));}}>继续本次分析</button></div>}
   {results&&<section aria-label="本次发现" className="idd-results"><p className="idd-kicker">本次结果 · {bundle?.sources.length} 份明确资料</p>{!results.candidates.some(c=>c.eligibility==="verifiedSources")&&<p>{results.reason??"这次没有可保留的有依据发现；这不代表其他资料中没有联系。"}</p>}{(showAll?results.candidates:results.candidates.slice(0,3)).map(candidate=><article className="idd-finding" key={candidate.findingPointer}>{candidate.eligibility!=="verifiedSources"?<p className="insights-muted">{candidate.reason??"此条依据当前不可采用"}</p>:<>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{img:()=>null,a:({children})=><span>{children}</span>}}>{candidate.text??""}</ReactMarkdown>
    {!!results.contextOptions?.length&&<details><summary>本轮共同背景 · {results.contextOptions.length}份</summary>{results.contextOptions.map(c=><button type="button" key={c.evidenceId} onClick={()=>void readSource(c)}>{c.title}</button>)}</details>}<InsightMethods entries={candidate.methodDependencies}/><div className="idd-evidence">{candidate.sourceCitations?.filter((s,i,all)=>all.findIndex(x=>JSON.stringify([x.excerpt.locator,x.excerpt.version,x.excerpt.startChar,x.excerpt.endChar])===JSON.stringify([s.excerpt.locator,s.excerpt.version,s.excerpt.startChar,s.excerpt.endChar]))===i).map((s,i)=><button key={i} type="button" onClick={()=>void readSource(s.excerpt)}><BookOpen size={14}/>{s.excerpt.title}</button>)}</div>
    {targetItem&&<p className="insights-muted">维持会保留原判断文字，将本次说明与新依据存入修订历史；采用修订则使用上面的新正文。来源已变化时须先重新核对。</p>}
    {saved[candidate.findingPointer]?<div className="idd-saved" role="status"><Check size={16}/>{reviewing?"本次复核已保存，原历史保留。":"已保留，已进入发现列表。"}<button type="button" onClick={()=>onView(saved[candidate.findingPointer])}>查看历史与纠正</button><button type="button" onClick={()=>follow(saved[candidate.findingPointer])}><GitBranch size={14}/>加入后续记录</button></div>:<><label className="idd-check"><input type="checkbox" checked={!!checked[candidate.findingPointer]} onChange={e=>setChecked(old=>({...old,[candidate.findingPointer]:e.target.checked}))}/>已核对这条发现的直接依据、共同背景、分析方法与适用条件</label><footer>{targetItem?<><button type="button" disabled={busy||!checked[candidate.findingPointer]} onClick={()=>void save(candidate,"maintain")}>维持判断并留记录</button><button type="button" className="insights-primary" disabled={busy||!checked[candidate.findingPointer]} onClick={()=>void save(candidate,"revise")}>采用这次修订</button></>:<button type="button" className="insights-primary" disabled={busy||!checked[candidate.findingPointer]} onClick={()=>void save(candidate)}><Plus size={15}/>保留这条发现</button>}</footer></>}
   </>}</article>)}{!showAll&&results.candidates.length>3&&<button type="button" onClick={()=>setShowAll(true)}>再看 {results.candidates.length-3} 条发现</button>}</section>}
   {results&&status?.work.report&&<details className="idd-answer"><summary>查看完整回答与说明</summary><ReactMarkdown remarkPlugins={[remarkGfm]} components={{img:()=>null,a:({children})=><span>{children}</span>}}>{status.work.report.prose?.markdown??status.work.report.summary}</ReactMarkdown></details>}
   {id&&<footer className="idd-run-footer"><button type="button" onClick={()=>onOpenWork(id)}>查看原分析与用量<ArrowRight size={14}/></button><button type="button" disabled={busy} onClick={()=>void refresh(id)}>刷新结果</button></footer>}
  </>}
  {(error||status?.run?.error)&&<p className="insights-error" role="alert">{error||status?.run?.error}</p>}
 </div>;
}
