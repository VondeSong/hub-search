import {useContext,useEffect,useMemo,useRef,useState,type CSSProperties,type ReactNode,type Ref} from "react";
import {ArrowDownUp,ArrowUpRight,Bell,BellOff,BookOpen,CalendarDays,Check,CheckCircle2,ChevronDown,ChevronRight,Clock3,FileSearch,FileText,Globe2,History,LayoutGrid,Layers3,MessageSquare,MoreHorizontal,PanelLeft,PanelRight,Plus,RefreshCw,Search,ShieldCheck,SlidersHorizontal,Sparkles,Star,Table2,TriangleAlert,X} from "lucide-react";
import ReactMarkdown from "react-markdown";
import {useInsights} from "./useInsights";
import {InsightNotebookWorkspace} from "./InsightNotebookWorkspace";
import {InsightHistory} from "./InsightHistory";
import {InsightCases} from "./InsightCases";
import {StageReview} from "./StageReview";
import {InsightRecall} from "./InsightRecall";
import {InsightDiscovery} from "./InsightDiscovery";
import {InsightMethods} from "./InsightMethods";
import {InsightTaskLinkSection} from "./InsightTaskLinkSection";
import {findingSections} from "./InsightFindingText";
import type {Insight,InsightCandidates,InsightDelivery,InsightEvent,InsightSource} from "./InsightTypes";
import type {LibrarySummary} from "./SearchTypes";
import type {WorkSummary} from "./AgentConversationHistoryData";
import {AgentPanelContext} from "./StandaloneAgentLauncher";
import {AgentCitationPreview} from "./AgentCitationPreview";
import {WorkspaceHeaderContext} from "./WorkspaceChrome";
import {userProfileStorage} from "./UserProfileStorage";
import "./InsightsWorkspace.css";

const stateNames={attention:"待关注",later:"稍后",done:"已处理"};
const validityNames={available:"依据已核对",review:"待复核",unavailable:"来源不可用"};
const perspectiveNames:Record<string,string>={knowledge:"知识与工作",life:"生活与进展",decision:"决定与变化"};
const stateTabs=["all","attention","later","done"] as const;
const defaultListWidth=344;
const minimumListWidth=260;
const maximumListWidth=500;
const INSIGHTS_LIST_WIDTH_KEY="hub.insights.list-width.v1";
const SPLIT_DRAG_THRESHOLD_PX=3;
const clampListWidth=(width:number)=>Math.max(minimumListWidth,Math.min(maximumListWidth,Math.round(width)));
const loadInsightsListWidth=()=>{
 try{
  const raw=userProfileStorage.getItem(INSIGHTS_LIST_WIDTH_KEY);
  if(raw===null)return defaultListWidth;
  const parsed=Number(raw);
  return Number.isFinite(parsed)?clampListWidth(parsed):defaultListWidth;
 }catch{return defaultListWidth;}
};
const saveInsightsListWidth=(width:number)=>{
 try{userProfileStorage.setItem(INSIGHTS_LIST_WIDTH_KEY,String(clampListWidth(width)));}catch{
  // Ignore storage errors so resizing remains responsive.
 }
};
const reviewNatureNames={fact:"资料陈述",selfReported:"用户自述",coOccurrence:"共同出现",inference:"模型推测"};
const inputNatureNames:Record<string,string>={selfReport:"本人记录",repost:"转贴材料",quotation:"引用他人",unknown:"性质未明确"};
const reasonNames:Record<string,string>={methodContextChanged:"分析方法或工作约定已变化",sourceChanged:"资料内容已变化",sourceUnavailable:"资料已删除或撤回访问",feedback:"有待处理的用户纠正",restore:"恢复后需要核对来源",userContextChanged:"已采用的用户补充发生变化",reviewDependencyChanged:"回顾的材料、窗口或覆盖发生变化"};
const time=(at:number)=>new Intl.DateTimeFormat("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(at);
type Data=ReturnType<typeof useInsights>;

function InsightDialog({title,children,onClose,wide=false,inline=false,className=""}:{title:string;children:ReactNode;onClose:()=>void;wide?:boolean;inline?:boolean;className?:string}){
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{if(inline)return;const node=ref.current;if(node?.showModal)node.showModal();else if(node)node.open=true;return()=>{node?.close?.();};},[inline]);
 if(inline)return <section className="insights-inline-detail" aria-label={title}><header><h2>{title}</h2><button type="button" aria-label="关闭详情" onClick={onClose}><X size={18}/></button></header>{children}</section>;
 return <dialog ref={ref} className={`insights-dialog${wide?" insights-dialog-wide":""} ${className}`} aria-label={title} onCancel={event=>{event.preventDefault();onClose();}}>
  <header><h2>{title}</h2><button type="button" className="icon-button" aria-label="关闭对话框" onClick={onClose}><X size={19}/></button></header>{children}
 </dialog>;
}

function ResultPicker({data,target,onClose,onOpenWork}:{data:Data;target?:Insight;onClose:()=>void;onOpenWork:(id:string)=>void}){
 const [works,setWorks]=useState<WorkSummary[]>([]),[workId,setWorkId]=useState(target?.workId??""),[workQuery,setWorkQuery]=useState(""),[worksLoading,setWorksLoading]=useState(false);
 const [deliveries,setDeliveries]=useState<InsightDelivery[]>([]),[before,setBefore]=useState<string|null>(null),[deliveryId,setDeliveryId]=useState("");
 const [candidates,setCandidates]=useState<InsightCandidates|null>(null),[selected,setSelected]=useState<string[]>([]),[contexts,setContexts]=useState<string[]>([]),[checked,setChecked]=useState(false);
 const [feedbacks,setFeedbacks]=useState<string[]>([]),[error,setError]=useState(""),[loading,setLoading]=useState(true),[saved,setSaved]=useState(0),[workCursor,setWorkCursor]=useState<unknown>(null);
 const deliveriesRequest=useRef(0),candidatesRequest=useRef(0),saving=useRef(false),verifiedCandidates=useRef(""),pickerBody=useRef<HTMLDivElement>(null),pickerScroll=useRef(0);
 // Work metadata belongs to the user; registry refreshes revalidate the selected
 // delivery below without resetting pagination through the user's Work history.
 useEffect(()=>{let active=true;setWorksLoading(true);void data.selectWorks(undefined,workQuery.trim()).then(v=>{if(!active)return;setWorks(v.works);setWorkCursor(v.nextCursor);if(!target)setWorkId(v.works[0]?.id??"");}).catch(e=>active&&setError(String(e))).finally(()=>{if(active){setLoading(false);setWorksLoading(false);}});return()=>{active=false;};},[workQuery]);
 useEffect(()=>{if(!workId)return;const ticket=++deliveriesRequest.current;setLoading(true);setError("");setCandidates(null);setSelected([]);setChecked(false);setContexts([]);setDeliveries([]);setDeliveryId("");void data.deliveries(workId).then(v=>{if(ticket!==deliveriesRequest.current)return;setDeliveries(v.items);setBefore(v.nextBeforeRecordId??null);setDeliveryId(v.items[0]?.deliveryRecordId??"");}).catch(e=>ticket===deliveriesRequest.current&&setError(String(e))).finally(()=>ticket===deliveriesRequest.current&&setLoading(false));return()=>{++deliveriesRequest.current;};},[workId]);
 useEffect(()=>{if(!deliveryId)return;const ticket=++candidatesRequest.current;setLoading(true);setCandidates(null);void data.candidates(workId,deliveryId).then(v=>{if(ticket!==candidatesRequest.current)return;const signature=JSON.stringify(v);if(signature!==verifiedCandidates.current){pickerScroll.current=0;setChecked(false);setContexts([]);setSelected([]);}verifiedCandidates.current=signature;setCandidates(v);}).catch(e=>{if(ticket===candidatesRequest.current){verifiedCandidates.current="";setChecked(false);setSelected([]);setError(String(e));}}).finally(()=>ticket===candidatesRequest.current&&setLoading(false));return()=>{++candidatesRequest.current;};},[workId,deliveryId,data.generation]);
 useEffect(()=>{if(!loading&&pickerBody.current)pickerBody.current.scrollTop=pickerScroll.current;},[loading]);
 const pendingFeedback=(target?.events??[]).filter(e=>e.kind==="insightFeedback"&&e.body?.kind==="correction"&&target?.reasons.some(r=>r.active&&r.kind==="feedback"&&r.reference?.feedbackId===e.id));
 const toggle=(values:string[],key:string)=>values.includes(key)?values.filter(v=>v!==key):[...values,key];
 const save=async()=>{
  if(!candidates||saving.current||!checked)return;saving.current=true;setError("");
  try{for(const candidate of candidates.candidates.filter(v=>selected.includes(v.findingPointer))){await data.saveCandidate(candidates.origin,candidate,target,feedbacks,contexts);setSelected(old=>old.filter(v=>v!==candidate.findingPointer));setSaved(n=>n+1);}await data.refresh();if(target)onClose();}
  catch(e){setError(String(e));}finally{saving.current=false;}
 };
 return <InsightDialog title={target?"更新这条发现":"从已有成果保存发现"} onClose={onClose} wide className="insights-result-picker">
  <p className="insights-dialog-intro">选择已发布、带可核对引用的结构化发现。浏览与保存不会启动分析。</p>
  {!target&&<div className="insights-picker-controls"><label>搜索事项<input aria-label="搜索成果事项" placeholder="按事项标题查找…" maxLength={200} value={workQuery} onChange={e=>{setWorkQuery(e.target.value);setWorkId("");setCandidates(null);setChecked(false);setSelected([]);}}/></label></div>}
  <div className="insights-picker-controls"><label>事项<select aria-label="成果事项" value={workId} disabled={!!target||loading||worksLoading} onChange={e=>setWorkId(e.target.value)}><option value="">选择事项</option>{works.map(w=><option key={w.id} value={w.id}>{w.goal}</option>)}{target&&!works.some(w=>w.id===target.workId)&&<option value={target.workId}>原事项</option>}</select></label>
   {workCursor!=null&&!target&&<button type="button" disabled={worksLoading} onClick={()=>{setWorksLoading(true);void data.selectWorks(workCursor,workQuery.trim()).then(v=>{setWorks(old=>[...old,...v.works.filter(w=>!old.some(o=>o.id===w.id))]);setWorkCursor(v.nextCursor);}).catch(e=>setError(String(e))).finally(()=>setWorksLoading(false));}}>更多事项</button>}
   <label>已发布成果<select aria-label="选择固定成果" value={deliveryId} disabled={loading} onChange={e=>setDeliveryId(e.target.value)}><option value="">选择成果</option>{deliveries.map(d=><option key={d.deliveryRecordId} value={d.deliveryRecordId}>{time(d.generatedAt)} · {d.findingCount} 条候选</option>)}</select></label>
   {before&&<button type="button" disabled={loading} onClick={()=>void data.deliveries(workId,before).then(v=>{setDeliveries(old=>[...old,...v.items]);setBefore(v.nextBeforeRecordId??null);}).catch(e=>setError(String(e)))}>更早的成果</button>}
  </div>
  {candidates&&<p className="insights-dialog-intro">成果生成于 {time(candidates.origin.generatedAt)}。下方逐条列出实际依据；核对范围是 Hub 当前已同步的内容，远端最新状态仍需到来源查看。</p>}
  <div className="insights-picker-body" ref={pickerBody} onScroll={e=>{if(!loading)pickerScroll.current=e.currentTarget.scrollTop;}} aria-busy={loading}>{loading?<p role="status">正在核对成果和当前依据…</p>:!workId?<p>尚无可选择的事项。先在 Hub 助手中分析授权资料，明确要求“给出有依据的结构化发现”。</p>:!deliveryId?<p>该事项尚无已发布成果，可在原事项中继续。</p>:candidates?.reason?<p role="status">{candidates.reason}</p>:candidates?.candidates.map(candidate=><div className="insights-candidate" key={candidate.findingPointer}>
   {candidate.eligibility==="unavailable"?<p className="insights-notice">{candidate.reason}</p>:<><label><input type={target?"radio":"checkbox"} name="insightCandidate" checked={selected.includes(candidate.findingPointer)} onChange={()=>{setSelected(target?[candidate.findingPointer]:toggle(selected,candidate.findingPointer));setChecked(false);}}/><span className="insights-candidate-text"><ReactMarkdown skipHtml allowedElements={["strong","em","code","br"]} unwrapDisallowed>{candidate.text}</ReactMarkdown></span></label>
    {candidate.reviewDependency&&<div className="insights-notice"><p>{reviewNatureNames[candidate.reviewDependency.nature]} · 回顾依据</p>{candidate.reviewDependency.dependencies.filter(d=>d.kind==="userInput").map((d,i)=><blockquote key={i}>{d.quote}<small>{inputNatureNames[d.nature??"unknown"]} · 版本 {d.version}</small></blockquote>)}</div>}
    <InsightMethods entries={candidate.methodDependencies}/><div className="insights-source-list">{candidate.sourceCitations?.map((source,index)=><details key={index}><summary><FileText size={14}/>{source.excerpt.title} · 已核对版本</summary><blockquote>{source.quote}</blockquote><small>{source.excerpt.sourcePath} · 第 {source.excerpt.startChar+1}–{source.excerpt.endChar} 字符</small></details>)}</div></>}
   </div>)}
   {!!candidates?.candidates.some(v=>v.eligibility==="verifiedSources")&&<fieldset className="insights-background"><legend>影响判断的共同背景（如有）</legend><p>这里只列出本次成果实际读取且当前可用的材料；按选中发现的实际依赖选择。</p>{candidates.contextOptions?.map(context=><label key={context.evidenceId}><input type="checkbox" checked={contexts.includes(context.evidenceId)} onChange={()=>{setContexts(toggle(contexts,context.evidenceId));setChecked(false);}}/>{context.title}</label>)}
    <label className="insights-confirm"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/>已核对所选发现的直接依据、必要背景和分析方法</label></fieldset>}
   {!!pendingFeedback.length&&<fieldset className="insights-background"><legend>这次成果已按哪些补充修正</legend><p>只选择本次实际送入运行、并已在新结论中处理的补充；未选项继续待复核。</p>{pendingFeedback.map(f=><label key={f.id}><input type="checkbox" checked={feedbacks.includes(f.id)} onChange={()=>setFeedbacks(toggle(feedbacks,f.id))}/>{f.body?.text}</label>)}</fieldset>}
  </div>
  {error&&<p className="insights-error" role="alert">{error}</p>}{saved>0&&<p role="status">已保存 {saved} 条；重复选择不会新增发现或重置状态。</p>}
  {data.unresolved&&<p className="insights-dialog-intro" role="status">有一项保存结果需要核对，已确认保存的内容会保留。关闭此窗口后，可在发现页核对提交结果。</p>}
  <footer>{workId&&<button type="button" onClick={()=>onOpenWork(workId)}>查看原事项</button>}<button type="button" onClick={onClose}>取消</button><button type="button" className="insights-primary" disabled={!selected.length||!checked||data.busy||loading||!!data.unresolved} onClick={()=>void save()}><Check size={16}/>{data.busy?"正在保存…":target?"确认更新这条发现":"保存所选发现"}</button></footer>
 </InsightDialog>;
}

function InsightDetail({data,item,onClose,onUpdate,onOpenWork,libraries,onOpenTask,inline=false,onPrevious,onNext,focus,onFocus,initialFeedback,onFeedback,onSnooze,desktop=false,closeRef,onReview}:{data:Data;desktop?:boolean;closeRef?:Ref<HTMLButtonElement>;onReview:()=>void;item:Insight;initialFeedback:string;onFeedback:(value:string)=>void;onSnooze:()=>void;onPrevious?:()=>void;onNext?:()=>void;focus:boolean;onFocus:()=>void;onClose:()=>void;onUpdate:()=>void;onOpenWork:(id:string)=>void;libraries?:LibrarySummary[];onOpenTask?:(target:{taskId:string;libraryId:string;insightId:string})=>void;inline?:boolean}){
 const [drawer,setDrawer]=useState<"sources"|"inspect"|null>(null);
 const citationTicket=useRef(0);
 const [feedback,setFeedbackState]=useState(initialFeedback),[kind,setKind]=useState("correction"),[source,setSource]=useState<InsightSource|null>(null),[error,setError]=useState(""),[sendFeedbackIds,setSendFeedbackIds]=useState<string[]>([]),[restoreConfirmed,setRestoreConfirmed]=useState(false);
 useEffect(()=>{
  ++citationTicket.current;
  setSource(null);
  if(item.checking||!item.snapshot)setDrawer(null);
 },[item.checking,item.contentRevision,item.snapshot]);
 const setFeedback=(value:string)=>{setFeedbackState(value);onFeedback(value);};
 const current=(item.contentRevision??item.headRevision)===item.headRevision;
 const act=(action:string,fields:Record<string,unknown>={})=>data.change(item,action,fields).catch(e=>setError(String(e)));
 const pending=item.events?.filter(e=>e.kind==="insightFeedback"&&e.body?.kind==="correction"&&item.reasons.some(r=>r.active&&r.kind==="feedback"&&r.reference?.feedbackId===e.id))??[];
 const lastStatus=[...(item.events??[])].reverse().find(e=>e.kind==="insightStatus");
 const submit=async()=>{try{await data.change(item,"insightFeedback",{text:feedback.trim(),kind});setFeedback("");}catch(e){setError(String(e));}};
 const closeDrawer=()=>{++citationTicket.current;setDrawer(null);setSource(null);};
 const toggleDrawer=(next:"sources"|"inspect")=>{
  if(drawer===next){closeDrawer();return;}
  ++citationTicket.current;setDrawer(next);setSource(null);
 };
 const openCitation=async(index:number)=>{
  const ticket=++citationTicket.current;
  try{
   const value=await data.source(item,index);
   if(ticket!==citationTicket.current)return;
   setSource(value);if(desktop)setDrawer("sources");
  }catch(error){if(ticket===citationTicket.current)setError(String(error));}
 };
 const text=item.snapshot?.text??"";
 const title=findingPreview(text).title;
 const readerText=desktop?text.replace(/^#{1,3}[ \t]+发现[ \t]*[:：]?[ \t]*\r?\n\s*/u,""):text;
 const separateTitle=desktop&&title.length>0&&readerText.startsWith(title);
 const displayedText=separateTitle?readerText.slice(title.length).trimStart():readerText;
 const revisions=<label className="insights-revisions"><span>{desktop?"内容版本":"查看内容版本"}</span><select aria-label="查看内容版本" value={item.contentRevision??item.headRevision} onChange={e=>void data.open(item.id,Number(e.target.value)).catch(e=>setError(String(e)))}>{Array.from({length:item.headRevision},(_,i)=>i+1).reverse().map(n=><option key={n} value={n}>版本 {n}{n===item.headRevision?"（当前）":""}</option>)}</select></label>;
 const citations=<div className="insights-source-list">{item.snapshot?.sourceCitations.map((citation,index)=><article key={index}><strong>{citation.excerpt.title}</strong><blockquote>{citation.quote}</blockquote><button type="button" disabled={data.busy} onClick={()=>void openCitation(index)}>查看引用原文 <ArrowUpRight size={13}/></button></article>)}</div>;
 const navigation=<div className="insights-detail-navigation"><button type="button" disabled={!onPrevious} onClick={onPrevious}>上一条</button><button type="button" disabled={!onNext} onClick={onNext}>下一条</button><button type="button" aria-pressed={focus} onClick={onFocus}>{focus?"退出专注":"专注阅读"}</button>
   {desktop&&<div className="insights-detail-tools">
    <button type="button" className="icon-button insights-tool-quote" aria-label="原文引文核对" title="原文引文核对" aria-expanded={drawer==="sources"} disabled={!item.snapshot||item.checking} onClick={()=>toggleDrawer("sources")}>{item.validity==="review"&&<span className="insights-review-dot" aria-hidden="true"/>}<FileSearch size={16}/></button>
    <button type="button" className="icon-button" aria-label="版本与溯源" title="版本与溯源" aria-expanded={drawer==="inspect"} disabled={!item.snapshot||item.checking} onClick={()=>toggleDrawer("inspect")}><ShieldCheck size={16}/></button>
    <button type="button" className="insights-tool-ask" aria-label="打开原事项助手" title="打开原事项助手" disabled={!item.snapshot||item.checking} onClick={()=>onOpenWork(item.workId)}><Sparkles size={13}/><span>问助手</span></button>
   </div>}
 </div>;
 const body=<>
  {(!inline||!desktop)&&navigation}
  <div className="insights-detail-body"><div className="insights-detail-article">{!desktop&&source&&item.snapshot&&!item.checking?<AgentCitationPreview value={{excerpt:source.excerpt,quote:source.quote??"",onReturn:()=>setSource(null)}}/>:<>
   {separateTitle&&<h2 className="insights-finding-heading">{title}</h2>}
   <div className="insights-detail-meta">{desktop?<><FindingStatus item={item}/><FindingValidity item={item}/></>:<><span>{stateNames[item.processingState]}</span><span>{validityNames[item.validity]}</span></>}
    {desktop&&item.snapshot?revisions:<span>内容版本 {item.contentRevision??item.headRevision}</span>}
    {desktop&&item.snapshot&&current&&<button type="button" className="insights-star" disabled={data.busy} aria-label={item.starred?"取消星标":"星标发现"} aria-pressed={!!item.starred} onClick={()=>void act("insightStar",{starred:!item.starred})}><Star size={15} fill={item.starred?"currentColor":"none"}/></button>}
    {!desktop&&<span>{time(item.updatedAt)}</span>}
   </div>
   {desktop&&<div className="insights-detail-divider" aria-hidden="true"/>}
   {!item.snapshot?<section className="insights-notice"><p>{item.checking?"正在重新核对当前访问；未保存的补充已暂时保留。":item.restorePending?"这条发现来自恢复的备份。请重新确认原事项的资料访问，旧授权不会自动恢复。":"来源或原事项当前不可访问，已隐藏正文、引文与历史内容。"}</p>{item.restorePending&&<><button type="button" onClick={()=>onOpenWork(item.workId)}>到原事项查看资料范围</button><label className="insights-confirm"><input type="checkbox" checked={restoreConfirmed} onChange={e=>setRestoreConfirmed(e.target.checked)}/>我已核对当前本机资料的访问范围；远端最新状态仍需在来源库核对</label><button type="button" disabled={data.busy||!restoreConfirmed} onClick={()=>void act("insightRestoreAccess",{confirmCurrentAccess:true})}>重新确认原事项的本机访问</button></>}</section>:<>
    {desktop&&!current&&<div className="insights-notice insights-readonly" role="status"><History size={15}/><span>正在查看历史版本 {item.contentRevision}</span><button type="button" onClick={()=>void data.open(item.id).catch(e=>setError(String(e)))}>切换至当前版本</button></div>}
    {item.validity==="review"&&<section className={desktop?"insights-notice insights-evidence-review":"insights-notice"} aria-label="依据待复核">
     {desktop&&<strong><TriangleAlert size={16}/>依据待复核</strong>}
     {item.reasons.filter(r=>r.active).map(r=><p key={r.id}>{reasonNames[r.kind]??"依据或适用条件需要重新核对"}</p>)}
     {desktop&&current&&<button type="button" disabled={data.busy} onClick={onReview}><RefreshCw size={14}/>加入新记录并核对</button>}
    </section>}
    <div className="insights-finding-text"><ReactMarkdown skipHtml allowedElements={["p","strong","em","code","br","ul","ol","li","blockquote"]} unwrapDisallowed>{displayedText}</ReactMarkdown></div>
    <section className="insights-review-outcome">{item.snapshot.reviewOutcome&&<details><summary>{item.snapshot.reviewOutcome.kind==="maintain"?"本次核对：维持原判断":"本次核对：采用修订"}</summary><p className="insights-muted">对照修订 {item.snapshot.reviewOutcome.previousRevision}；原判断与本次新依据均在历史中保留。</p><ReactMarkdown skipHtml allowedElements={["p","strong","em","code","br","ul","ol","li","blockquote"]} unwrapDisallowed>{item.snapshot.reviewOutcome.comparison}</ReactMarkdown></details>}</section><div className="insights-detail-actions"><button type="button" onClick={()=>onOpenWork(item.workId)}><ArrowUpRight size={15}/>原事项</button><button type="button" disabled={!current||data.busy} onClick={()=>void act("insightFollow",{followed:!item.followed})}>{desktop?<Bell size={15}/>:<Star size={15}/>}{item.followed?"不再关注":"重新关注"}</button><button type="button" disabled={!current||data.busy} onClick={onUpdate}><RefreshCw size={15}/>选择新成果更新</button></div>
    <InsightTaskLinkSection insight={item} insightTitle={title} libraries={libraries} onOpenTask={onOpenTask} disabled={!current||data.busy}/>
    {item.snapshot.reviewDependency&&<section><h4>回顾依据 · {{fact:"资料陈述",selfReported:"用户自述",coOccurrence:"共同出现",inference:"模型推测"}[item.snapshot.reviewDependency.nature]}</h4><p className="insights-muted">性质保留于保存时；“依据已核对”表示出处可用。</p>{item.snapshot.reviewDependency.dependencies.filter(d=>d.kind==="userInput").map((d,i)=><blockquote key={i}>{d.quote}<small>贴入材料 · {inputNatureNames[d.nature??"unknown"]} · 版本 {d.version}</small></blockquote>)}</section>}
    {current&&<label className="insights-perspective-field"><span>发现视角</span><select aria-label="发现视角" value={item.perspective??""} disabled={data.busy} onChange={e=>void act("insightPerspective",{perspective:e.target.value})}><option value="">未指定</option><option value="knowledge">知识与工作</option><option value="life">生活与进展</option><option value="decision">决定与变化</option></select></label>}
    <InsightMethods entries={item.snapshot.methodDependencies}/><h4>资料依据</h4><p className="insights-muted">保存时的精确引文；查看原文时会再次核对当前权限和版本。</p>
    {drawer!=="sources"&&citations}
    {!!item.snapshot.contextDependencies.length&&<section><h4>共同背景</h4>{item.snapshot.contextDependencies.map((context,index)=><p key={index}>{context.excerpt.title}</p>)}</section>}
    {!!item.snapshot.userContextRefs.length&&<section><h4>已采用的用户补充</h4>{item.snapshot.userContextRefs.map(ref=><blockquote key={ref.feedbackId}>{ref.text}<small>用户自述 · 经明确确认采用</small></blockquote>)}</section>}
    {current&&<section className="insights-feedback"><h4>补充与纠正</h4><label>反馈类型<select aria-label="反馈类型" value={kind} onChange={e=>setKind(e.target.value)}><option value="correction">事实或关联需要纠正</option><option value="notNeeded">现在不需要</option></select></label><label>你的补充<textarea aria-label="你的补充" rows={3} maxLength={3000} value={feedback} onChange={e=>setFeedback(e.target.value)} placeholder="说明哪一点需要补充或纠正…"/></label><button type="button" disabled={data.busy||!feedback.trim()} onClick={()=>void submit()}><MessageSquare size={15}/>保存反馈</button>
     {!!pending.length&&<div className="insights-review-action"><p>已保存 {pending.length} 条待处理纠正。选择本轮补充，在原事项中运行助手；生成后仍需选择新成果明确更新。</p>{pending.map(f=><label className="insights-feedback-choice" key={f.id}><input type="checkbox" checked={sendFeedbackIds.includes(f.id)} onChange={()=>setSendFeedbackIds(old=>old.includes(f.id)?old.filter(id=>id!==f.id):[...old,f.id])}/>{f.body?.text}</label>)}<button type="button" disabled={data.busy||!sendFeedbackIds.some(id=>pending.some(f=>f.id===id))} onClick={()=>void data.runReview(item,sendFeedbackIds.filter(id=>pending.some(f=>f.id===id)),onOpenWork).catch(e=>setError(String(e)))}><RefreshCw size={15}/>按补充继续核对</button></div>}
    </section>}
    {current&&<ReplacementRelations data={data} item={item}/>}
    <section><h4><History size={16}/>历史与用户记录</h4>{!desktop&&revisions}
     <ol className="insights-events">{item.events?.map(event=><li key={event.id}><span>{time(event.createdAt)}</span><p>{event.restricted?"该修订当前不可访问":event.body?.text??eventLabel(event)}</p>{current&&!event.restricted&&event.kind==="insightFeedback"&&event.body?.kind==="correction"&&item.reasons.some(r=>r.active&&r.reference?.feedbackId===event.id)&&<button type="button" disabled={data.busy} onClick={()=>void act("insightWithdrawFeedback",{feedbackId:event.id})}>撤回这条纠正</button>}</li>)}</ol>
    </section>
   </>}
  </>}{error&&<p className="insights-error" role="alert">{error}</p>}</div></div>
  {desktop&&drawer&&item.snapshot&&!item.checking&&<aside className="insights-reading-drawer" aria-label={drawer==="sources"?"原文引文核对":"版本与溯源"}>
   <header><strong>{drawer==="sources"?<><FileSearch size={16}/>原文引文核对</>:<><ShieldCheck size={16}/>版本与溯源</>}</strong>
    <button type="button" className="icon-button" aria-label="关闭核对抽屉" onClick={closeDrawer}><X size={16}/></button></header>
   <div className="insights-drawer-body">
    {drawer==="sources"?(source?<AgentCitationPreview value={{excerpt:source.excerpt,quote:source.quote??"",onReturn:()=>setSource(null)}}/>:citations):<>
     <dl className="insights-provenance">
      <dt>原事项</dt><dd>{item.workTitle??"原事项"}</dd>
      <dt>当前内容</dt><dd>版本 {item.contentRevision??item.headRevision} / {item.headRevision}</dd>
      <dt>行修订</dt><dd>{item.rowRevision}</dd>
      <dt>依据状态</dt><dd>{validityNames[item.validity]}</dd>
      <dt>生成时间</dt><dd>{time(item.snapshot.origin.generatedAt)}</dd>
     </dl>
     <InsightMethods entries={item.snapshot.methodDependencies}/>
     {item.snapshot.reviewOutcome&&<section><h4>与版本 {item.snapshot.reviewOutcome.previousRevision} 的对照</h4><ReactMarkdown skipHtml allowedElements={["p","strong","em","code","br","ul","ol","li","blockquote"]} unwrapDisallowed>{item.snapshot.reviewOutcome.comparison}</ReactMarkdown></section>}
    </>}
   </div>
  </aside>}
  <footer>{item.snapshot&&current&&<><button type="button" disabled={data.busy} onClick={()=>void act("insightStatus",{state:"attention"})}>待关注</button><button type="button" disabled={data.busy} onClick={()=>void act("insightStatus",{state:"later",snoozeUntil:Date.now()+86_400_000})}><Clock3 size={15}/>稍后一天</button><button type="button" disabled={data.busy} onClick={onSnooze}>选择稍后时间</button><button type="button" disabled={data.busy} onClick={()=>void act("insightStatus",{state:"done"})}><CheckCircle2 size={15}/>已处理</button>{lastStatus&&<button type="button" disabled={data.busy} onClick={()=>void act("insightUndoStatus",{eventId:lastStatus.id})}>撤销上次处理</button>}</>}<button type="button" onClick={onClose}>返回列表</button></footer>
 </>;
 if(!inline||!desktop)return <InsightDialog title="发现与依据" onClose={onClose} wide inline={inline}>{body}</InsightDialog>;
 return <section className="insights-inline-detail insights-v4-detail" aria-label="发现与依据"
  onKeyDown={e=>{if(e.key==="Escape"&&drawer){e.preventDefault();e.stopPropagation();closeDrawer();}}}>
  <header className="insights-reading-toolbar">
   <span className="insights-reading-work" title={item.snapshot?item.workTitle:undefined}>{item.snapshot?item.workTitle??"发现与依据":"发现与依据"}</span>
   <time dateTime={new Date(item.updatedAt).toISOString()}>{time(item.updatedAt)}</time>
   {navigation}
   <button type="button" ref={closeRef} className="icon-button" aria-label="关闭详情" title="关闭详情" onClick={onClose}><X size={17}/></button>
  </header>
  {body}
 </section>;
}
function ReplacementRelations({data,item}:{data:Data;item:Insight}){
 const [chosen,setChosen]=useState(item.supersedes??[]),[confirmed,setConfirmed]=useState(false),[error,setError]=useState(""),[expanded,setExpanded]=useState(false);
 useEffect(()=>{setChosen(item.supersedes??[]);setConfirmed(false);setError("");},[item.rowRevision]);
 const eligible=data.items.filter(other=>other.id!==item.id&&other.workId===item.workId&&other.snapshot);
 const ids=[...new Set([...eligible.map(other=>other.id),...(item.supersedes??[])])];
 const unchanged=JSON.stringify([...chosen].sort())===JSON.stringify([...(item.supersedes??[])].sort());
 return <details className="insights-relations" onToggle={e=>setExpanded(e.currentTarget.open)}><summary>关联替代发现 · {item.supersedes?.length??0} 条<ChevronDown size={14}/></summary>{expanded&&<><p className="insights-muted">拆分或合并后，先将新发现单独保存，再关联它替代的原发现。原发现、处理状态和任务均会保留。</p>
  {ids.map(id=>{const other=data.items.find(value=>value.id===id);return <label key={id}><input type="checkbox" aria-label={other?.snapshot?`替代：${findingPreview(other.snapshot.text).title}`:"移除当前无法读取的替代关系"} checked={chosen.includes(id)} disabled={data.busy||(!chosen.includes(id)&&chosen.length>=12)} onChange={()=>{setChosen(old=>old.includes(id)?old.filter(value=>value!==id):[...old,id]);setConfirmed(false);}}/><span>{other?.snapshot?findingPreview(other.snapshot.text).title:other?"关联发现当前不可访问":"尚未载入的已关联发现"}{other?.snapshot?` · ${stateNames[other.processingState]}`:""}</span></label>;})}
  {!ids.length&&<p className="insights-muted">当前已载入的发现中，没有属于同一事项的其他可访问发现。</p>}
  {data.more&&<button type="button" disabled={data.loading||data.busy} onClick={()=>void data.refresh(true)}>载入更多已保存发现</button>}
  <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/><span>我已核对这些发现的对应关系；旧内容和处理状态仍保留</span></label>
  <button type="button" disabled={!confirmed||unchanged||data.busy||!!data.unresolved} onClick={()=>void data.change(item,"insightRelate",{supersedes:chosen}).then(()=>setConfirmed(false)).catch(e=>setError(String(e)))}>保存替代关系</button>{error&&<p className="insights-error" role="alert">{error}</p>}
 </>}</details>;
}

function FindingStatus({item}:{item:Insight}){
 return <span className="insights-processing" data-state={item.processingState}><i aria-hidden="true"/>{stateNames[item.processingState]}</span>;
}
function FindingValidity({item}:{item:Insight}){
 return <span className={`insights-validity insights-validity-${item.validity}`}>{item.checking?"正在核对依据":validityNames[item.validity]}</span>;
}

function eventLabel(event:InsightEvent){const labels:Record<string,string>={content:"保存了内容修订",existingOrigin:"确认了已有出处",reconcile:"核对了来源和出现时间",restore:"恢复后等待来源校验",insightStatus:"更新了处理状态",insightContinue:"将所选反馈送入原事项",insightWithdrawFeedback:"撤回了纠正，保留历史与依赖影响",insightFollow:"更新了关注设置",insightStar:"更新了星标",insightPerspective:"更新了发现视角",insightRelate:"关联了替代关系",insightUndoStatus:"撤销了处理动作"};return labels[event.kind]??"保存了用户操作";}

// Presentation only: shorten the heading without changing the saved finding or its evidence.
function findingPreview(text:string){
 text=findingSections(text).body;
 const heading=text.match(/^\*\*(.+?[。！？])\*\*\s*/u);
 if(heading)return {title:heading[1],body:text.slice(heading[0].length).trim()};
 const firstLine=text.split(/\n/)[0].trim();
 const sentence=firstLine.match(/^.{1,90}?[。！？](?:[”’」』])?/u)?.[0];
 const title=sentence??(firstLine.length<=90?firstLine:`${firstLine.slice(0,72)}…`);
 const rest=text.startsWith(title)?text.slice(title.length).trim():text;
 return {title,body:rest};
}

export type InsightsWorkspaceProps = {
 libraries?: LibrarySummary[];
 initialInsightId?: string;
 onInitialInsightHandled?: () => void;
 onOpenTask?: (target: { taskId: string; libraryId: string; insightId: string }) => void;
};

export function InsightsWorkspace(props: InsightsWorkspaceProps = {}){
 const { libraries, initialInsightId, onInitialInsightHandled, onOpenTask } = props;
 const [section,setSection]=useState<"discoveries"|"stageReview"|"cases"|"topic"|"draft"|"decision"|"history">("discoveries");
 const data=useInsights(),openAgent=useContext(AgentPanelContext),chrome=useContext(WorkspaceHeaderContext);
 const desktop=document.documentElement.dataset.runtimePlatform!=="android";
 const [filter,setFilter]=useState<Insight["processingState"]|"all">(desktop?"all":"attention"),[query,setQuery]=useState(""),[days,setDays]=useState(0),[picker,setPicker]=useState<{target?:Insight}|null>(null);
 const [discovery,setDiscovery]=useState<{target?:Insight}|null>(null);
 const [recall,setRecall]=useState(false),[decisions,setDecisions]=useState(false),[snooze,setSnooze]=useState<Insight|null>(null),[snoozeDate,setSnoozeDate]=useState("");
 const localDate=(hours:number)=>{const d=new Date(Date.now()+hours*3600000);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
 const openSnooze=(item:Insight)=>{setSnooze(item);setSnoozeDate(localDate(24));};
 const [workFilter,setWorkFilter]=useState(""),[focus,setFocus]=useState(false);
 const detailDrafts=useRef<Record<string,string>>({});
 const navigationClose=useRef<HTMLButtonElement>(null),navigationTrigger=useRef<HTMLButtonElement>(null);
 const [scope,setScope]=useState<"all"|"review"|"starred"|"knowledge"|"life"|"decision">("all"),[perspectiveFilter,setPerspectiveFilter]=useState<""|"knowledge"|"life"|"decision">(""),[validity,setValidity]=useState("all"),[layout,setLayout]=useState<"cards"|"split"|"table">(desktop?"split":"cards"),[navigation,setNavigation]=useState<"auto"|"open"|"closed">("auto");
 const [sortOldest,setSortOldest]=useState(false),[listWidth,setListWidth]=useState(loadInsightsListWidth);
 const [checkedIds,setCheckedIds]=useState<string[]>([]),[batchBusy,setBatchBusy]=useState(false),[batchResult,setBatchResult]=useState("");
 const splitDrag=useRef<{pointerId:number;x:number;width:number;dragged:boolean}|null>(null), listPane=useRef<HTMLDivElement>(null),navPane=useRef<HTMLElement>(null);
 const initialPreviewOpened=useRef(false);
 const visitedSections=useRef(new Set<typeof section>(["discoveries"]));
 if(desktop)visitedSections.current.add(section);
 const searchInput=useRef<HTMLInputElement>(null),tableClose=useRef<HTMLButtonElement>(null),tableRowTrigger=useRef<HTMLButtonElement|null>(null);

 useEffect(()=>{if(desktop)return;if(navigation==="open")navigationClose.current?.focus();else if(navigation==="closed"&&navPane.current?.contains(document.activeElement))navigationTrigger.current?.focus();},[desktop,navigation]);
 useEffect(()=>{
  if(!desktop||!focus)return;
  const onWindowKeyDown=(event:KeyboardEvent)=>{
   if(event.key!=="Escape"||event.defaultPrevented)return;
   const target=event.target instanceof Element?event.target:null;
   if(target?.closest("dialog, input, textarea, select, [contenteditable]"))return;
   event.preventDefault();
   setFocus(false);
  };
  window.addEventListener("keydown",onWindowKeyDown);
  return()=>window.removeEventListener("keydown",onWindowKeyDown);
 },[desktop,focus]);
 const openWork=(id:string,question?:string)=>{data.closeDetail();setPicker(null);setRecall(false);setDecisions(false);setDiscovery(null);openAgent?.({workId:id,...(question?{question:{id:crypto.randomUUID(),text:question}}:{})});};
 const visible=useMemo(()=>{const rows=data.items.filter(item=>(filter==="all"||item.processingState===filter)&&(scope!=="review"||item.validity==="review")&&(scope!=="starred"||item.starred)&&(!["knowledge","life","decision"].includes(scope)||item.perspective===scope)&&(!perspectiveFilter||item.perspective===perspectiveFilter)&&(!workFilter||item.workId===workFilter)&&(validity==="all"||item.validity===validity)&&(!days||item.createdAt>=Date.now()-days*86_400_000)&&(!query.trim()||item.snapshot?.text.toLowerCase().includes(query.trim().toLowerCase())||item.snapshot?.sourceCitations.some(s=>`${s.excerpt.title} ${s.quote??""} ${s.excerpt.content??""}`.toLowerCase().includes(query.trim().toLowerCase()))||item.snapshot&&`${item.workTitle??""} ${item.workId}`.toLowerCase().includes(query.trim().toLowerCase())));return desktop?rows.sort((first,second)=>sortOldest?first.updatedAt-second.updatedAt:second.updatedAt-first.updatedAt):rows;
 },[data.items,filter,query,days,scope,perspectiveFilter,validity,workFilter,desktop,sortOldest]);
 const attentionCount=data.items.filter(item=>item.processingState==="attention").length;
 const reviewCount=data.items.filter(item=>item.validity==="review").length;
 const starredCount=data.items.filter(item=>item.starred).length;
 const filtered=days!==0||validity!=="all"||!!workFilter;
 const hasActiveFilter=filtered||filter!=="all"||scope!=="all"||!!perspectiveFilter||!!query.trim();
 const reset=()=>{setFilter("all");setQuery("");setDays(0);setValidity("all");setScope("all");setPerspectiveFilter("");setWorkFilter("");};
 const openFinding=(item:Insight)=>{initialPreviewOpened.current=true;void data.open(item.id).catch(()=>undefined);};
 useEffect(()=>{
  if(!desktop||section!=="discoveries"||layout!=="split"||data.detail||initialPreviewOpened.current)return;
  const first=visible.find(item=>item.snapshot&&!item.checking);
  if(!first||(listPane.current?.parentElement?.clientWidth??0)<=740)return;
  initialPreviewOpened.current=true;
  void data.open(first.id).catch(()=>undefined);
 },[desktop,section,layout,visible,data.detail,data.open]);
 useEffect(()=>{
  if(!initialInsightId)return;
  setSection("discoveries");
  setScope("all");
  setPerspectiveFilter("");
  setFilter("all");
  setQuery("");
  setValidity("all");
  setDays(0);
  setWorkFilter("");
  initialPreviewOpened.current=true;
  void data.open(initialInsightId).catch(()=>undefined);
  onInitialInsightHandled?.();
 },[initialInsightId,data.open,onInitialInsightHandled]);
 const position=visible.findIndex(i=>i.id===data.detail?.id);
 const go=(delta:number)=>{const item=visible[position+delta];if(item)openFinding(item);};
 const navigate=(value:typeof section)=>{setSection(value);setCheckedIds([]);setFocus(false);data.closeDetail();};
 const selectedRows=visible.filter(item=>item.snapshot&&!item.checking&&checkedIds.includes(item.id));
 const canChoose=!data.busy&&!data.unresolved&&!batchBusy;
 const toggleRow=(id:string)=>setCheckedIds(previous=>previous.includes(id)?previous.filter(value=>value!==id):[...previous,id]);
 const chooseScope=(value:typeof scope)=>{setSection("discoveries");setScope(value);setPerspectiveFilter(value==="knowledge"||value==="life"||value==="decision"?value:"");setFilter(value==="all"?"attention":"all");setCheckedIds([]);};
 const canBatch=selectedRows.length>0&&canChoose;
 const applyBatch=async(action:"done"|"later"|"unfollow")=>{
  if(!canBatch)return;
  setBatchBusy(true);setBatchResult("");
  const until=Date.now()+86_400_000;
  let completed=0;
  try{
   for(const item of selectedRows){
    if(action==="unfollow")await data.change(item,"insightFollow",{followed:false});
    else await data.change(item,"insightStatus",{state:action,...(action==="later"?{snoozeUntil:until}:{})});
    completed++;
    setCheckedIds(previous=>previous.filter(id=>id!==item.id));
   }
   setBatchResult(`已处理 ${completed} 条发现`);
  }catch{
   setBatchResult(`已确认 ${completed} / ${selectedRows.length} 条，批量操作已暂停。请先核对当前操作的提交结果。`);
  }finally{setBatchBusy(false);}
 };
 const closeFinding=()=>{setFocus(false);data.closeDetail();if(layout==="table")requestAnimationFrame(()=>tableRowTrigger.current?.focus());};
 useEffect(()=>{if(layout==="table"&&data.detail?.id&&document.activeElement!==searchInput.current)tableClose.current?.focus();},[layout,data.detail?.id]);
 const handleSearchChange=(value:string)=>{
  setQuery(value);
  setCheckedIds([]);
  if(desktop&&section!=="discoveries"&&value.trim()){
   setSection("discoveries");
   setFocus(false);
  }
 };
 const clearSearch=()=>{
  setQuery("");
  setCheckedIds([]);
  searchInput.current?.focus();
 };
 const statusTabs=<div className="insights-tabs" role="tablist" aria-label="发现处理状态">
  {(desktop?stateTabs:[...stateTabs.slice(1),stateTabs[0]]).map((state,index,states)=><button type="button" key={state} role="tab" aria-selected={filter===state} tabIndex={filter===state?0:-1}
   onClick={()=>{setFilter(state);setCheckedIds([]);}}
   onKeyDown={e=>{if(e.key!=="ArrowLeft"&&e.key!=="ArrowRight")return;e.preventDefault();const next=(index+(e.key==="ArrowRight"?1:-1)+states.length)%states.length;setFilter(states[next]);setCheckedIds([]);(e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();}}>
   {state==="all"?"全部":stateNames[state]}<span>{data.items.filter(i=>state==="all"||i.processingState===state).length}</span>
  </button>)}
 </div>;
 const primaryModes=[["discoveries","全部发现"],["stageReview","阶段回顾"],["topic","关注主题"]] as const;
 const secondarySectionNames:Record<string,string>={cases:"真实案例",draft:"工作草稿",history:"处理记录",decision:"决定与条件"};
 const modeSwitch=<div className="insights-mode-switch" role="tablist" aria-label="洞察工作区视图">
  {primaryModes.map(([mode,label],index)=><button type="button" key={mode} role="tab" className={section===mode?"active":""} aria-selected={section===mode}
   onClick={()=>navigate(mode)}
   onKeyDown={e=>{if(e.key!=="ArrowLeft"&&e.key!=="ArrowRight")return;e.preventDefault();const next=(index+(e.key==="ArrowRight"?1:-1)+primaryModes.length)%primaryModes.length;navigate(primaryModes[next][0]);(e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();}}>
   <span>{label}</span>
   {mode==="discoveries"&&<span className="insights-mode-count">{data.items.length}{data.more?"+":""}</span>}
  </button>)}
 </div>;
 const mainActions=<div className="insights-header-actions">
  {(scope==="decision"||perspectiveFilter==="decision")&&<button type="button" onClick={()=>setDecisions(true)}>记录与回顾决定</button>}
  <button type="button" className="insights-primary" onClick={()=>setDiscovery({})}><Plus size={14}/>开始发现</button>
  {desktop&&<button type="button" className="insights-import" title="从已有分析导入" onClick={()=>setPicker({})}>从已有分析导入</button>}
  <details className="insights-menu"><summary aria-label="洞察更多操作"><MoreHorizontal size={18}/></summary><div className="insights-menu-content">
   {!desktop&&<button type="button" onClick={e=>{e.currentTarget.closest("details")?.removeAttribute("open");setPicker({});}}>从已有分析导入</button>}
   {data.detail?.snapshot&&<button type="button" onClick={e=>{e.currentTarget.closest("details")?.removeAttribute("open");setDiscovery({target:data.detail!});}}>加入新记录并核对当前发现</button>}
   <button type="button" onClick={e=>{e.currentTarget.closest("details")?.removeAttribute("open");setRecall(true);}}><BookOpen size={15}/>寻找旧知识</button>
   <button type="button" aria-label="核对当前来源" disabled={data.loading||data.busy} onClick={e=>{e.currentTarget.closest("details")?.removeAttribute("open");void data.refresh();}}><RefreshCw size={15}/>核对当前来源</button>
   {desktop&&<>
    <div className="insights-menu-sep" role="separator"/>
    <button type="button" onClick={e=>{e.currentTarget.closest("details")?.removeAttribute("open");navigate("draft");}}><FileText size={15}/>工作草稿</button>
    <button type="button" onClick={e=>{e.currentTarget.closest("details")?.removeAttribute("open");navigate("history");}}><History size={15}/>处理记录</button>
    <button type="button" onClick={e=>{e.currentTarget.closest("details")?.removeAttribute("open");navigate("cases");}}><Globe2 size={15}/>真实案例</button>
   </>}
  </div></details>
 </div>;
 const topbar=<div className="insights-topbar">
  <div className="insights-breadcrumb" onMouseDown={chrome?.onMouseDown}>
   {!desktop&&<button type="button" ref={navigationTrigger} className="insights-nav-trigger icon-button" aria-label="展开洞察侧边栏" title="展开洞察侧边栏" onClick={()=>setNavigation(navigation==="open"||(navigation==="auto"&&!!navPane.current?.offsetWidth)?"closed":"open")}><PanelLeft size={16}/></button>}
   {!desktop&&<><span>我的 Hub</span><ChevronRight size={14}/><span>洞察</span></>}
   {desktop&&modeSwitch}
   {desktop&&secondarySectionNames[section]&&<span className="insights-secondary-badge">{secondarySectionNames[section]}</span>}
  </div>
  <label className="insights-search"><Search size={14}/><input ref={searchInput} aria-label="搜索发现与依据" value={query} onChange={e=>handleSearchChange(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&desktop&&section!=="discoveries"&&query.trim()){e.preventDefault();setSection("discoveries");setFocus(false);}}} placeholder="搜索发现、事项与依据…"/>{query?<button type="button" className="insights-search-clear" aria-label="清除搜索" onClick={clearSearch}><X size={12}/></button>:desktop?<span className="insights-search-kbd" aria-hidden="true">/</span>:null}</label>
  {desktop&&mainActions}
  {chrome?.actions}
 </div>;
 const desktopViewTools=<div className="insights-view-tools">
  <button type="button" className="insights-sort" aria-pressed={sortOldest} aria-label={sortOldest?"按最早更新排序":"按最近更新排序"} title={sortOldest?"当前按最早更新排序，点击切换":"当前按最近更新排序，点击切换"} onClick={()=>setSortOldest(!sortOldest)}><ArrowDownUp size={12}/><span>{sortOldest?"最早":"最近"}</span></button>
  <details className="insights-menu insights-filter-menu"><summary aria-label="筛选发现" title="更多筛选（关联事项、时间与依据状态）" className={filtered?"is-filtered":""}><SlidersHorizontal size={13}/>{filtered&&<b>{Number(days!==0)+Number(validity!=="all")+Number(!!workFilter)}</b>}</summary><div className="insights-filter-popover"><header><strong>筛选发现</strong><button type="button" onClick={()=>{setDays(0);setValidity("all");setWorkFilter("");}}>重置</button></header><label>关联事项<select aria-label="关联事项" value={workFilter} onChange={e=>setWorkFilter(e.target.value)}><option value="">全部事项</option>{[...new Set(data.items.map(i=>i.workId))].map(id=><option key={id} value={id}>{data.items.find(i=>i.workId===id)?.workTitle??id}</option>)}</select></label><label>时间范围<select aria-label="发现时间" value={days} onChange={e=>setDays(Number(e.target.value))}><option value={0}>全部时间</option><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option></select></label><label>结论有效性<select aria-label="结论有效性" value={validity} onChange={e=>setValidity(e.target.value)}><option value="all">全部结论</option><option value="available">依据已核对</option><option value="review">待复核</option><option value="unavailable">来源不可用</option></select></label><button type="button" className="insights-primary" onClick={e=>e.currentTarget.closest("details")?.removeAttribute("open")}>完成</button></div></details>
  <div className="insights-layout-switch" aria-label="发现布局">
   <button type="button" aria-label="卡片浏览" title="卡片浏览" aria-pressed={layout==="cards"} onClick={()=>setLayout("cards")}><LayoutGrid size={13}/></button>
   <button type="button" aria-label="列表与详情" title="双栏列表" aria-pressed={layout==="split"} onClick={()=>setLayout("split")}><PanelRight size={13}/></button>
   <button type="button" aria-label="全宽属性表格" title="全宽属性表格" aria-pressed={layout==="table"} onClick={()=>{if(layout!=="table")data.closeDetail();setLayout("table");}}><Table2 size={13}/></button>
  </div>
 </div>;

 return <section className={`insights-workspace${desktop?" insights-v4":` insights-navigation-${navigation}`}${focus?" insights-focus":""}`} aria-label="洞察发现工作区" data-hub-keyboard-scope="insights"
  onKeyDown={e=>{
   if(!desktop||e.isDefaultPrevented()||e.ctrlKey||e.metaKey||e.altKey||e.nativeEvent.isComposing)return;
   if((e.target as HTMLElement).closest("input,textarea,select,[contenteditable],dialog"))return;
   if(e.key==="/"){e.preventDefault();searchInput.current?.focus();return;}
   if(section!=="discoveries")return;
   if(e.key==="Escape"&&focus&&!e.defaultPrevented){e.preventDefault();setFocus(false);}
   else if(e.key==="Escape"&&layout==="table"&&data.detail&&!e.defaultPrevented){e.preventDefault();closeFinding();}
   else if(e.key.toLowerCase()==="j"||e.key.toLowerCase()==="k"){
    e.preventDefault();go(e.key.toLowerCase()==="j"?1:-1);
   }
  }}>
  {desktop&&data.loading&&data.items.length>0&&<div className="insights-sweep-bar" aria-hidden="true"/>}
  {desktop&&topbar}
  {!desktop&&<aside ref={navPane} className="insights-navigation" aria-label="洞察导航" onKeyDown={e=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();setNavigation("closed");}}}>
   <header><strong>洞察</strong><button type="button" ref={navigationClose} className="icon-button" aria-label="收起洞察侧边栏" onClick={()=>setNavigation("closed")}><PanelLeft size={17}/></button></header>
   <nav aria-label="我的洞察"><p>我的洞察</p><button type="button" className={section==="discoveries"&&scope==="all"?"selected":""} aria-current={section==="discoveries"&&scope==="all"?"page":undefined} onClick={()=>chooseScope("all")}><Sparkles size={18}/><span>发现</span><small>{data.items.length}{data.more?"+":""}</small></button>
    <button type="button" className={section==="cases"?"selected":""} aria-current={section==="cases"?"page":undefined} onClick={()=>navigate("cases")}><Globe2 size={18}/><span>真实案例</span><small>5</small></button>
    <button type="button" className={section==="stageReview"?"selected":""} aria-current={section==="stageReview"?"page":undefined} onClick={()=>navigate("stageReview")}><CalendarDays size={18}/><span>阶段回顾</span></button>
    {([["topic",SlidersHorizontal,"关注主题"],["draft",FileText,"工作草稿"],["history",History,"处理记录"]] as const).map(([value,Glyph,label])=><button type="button" key={value} className={section===value?"selected":""} aria-current={section===value?"page":undefined} onClick={()=>navigate(value)}><Glyph size={18}/><span>{label}</span></button>)}
    <p>我的筛选</p><button type="button" className={section==="discoveries"&&scope==="review"?"selected":""} onClick={()=>chooseScope("review")}><History size={18}/><span>待复核</span><small>{reviewCount}</small></button><button type="button" className={scope==="starred"&&section==="discoveries"?"selected":""} onClick={()=>chooseScope("starred")}><Star size={18}/><span>星标发现</span><small>{data.items.filter(i=>i.starred).length}</small></button>
    <p>发现视角</p>{([["knowledge",BookOpen,"知识与工作"],["life",CalendarDays,"生活与进展"],["decision",ArrowUpRight,"决定与变化"]] as const).map(([value,Glyph,label])=><button type="button" key={value} className={section==="discoveries"&&scope===value?"selected":""} onClick={()=>chooseScope(value)}><Glyph size={18}/><span>{label}</span><small>{data.items.filter(i=>i.perspective===value).length}</small></button>)}
    <p>探索示例</p><button type="button" onClick={()=>navigate("cases")}><Layers3 size={18}/><span>更多发现示例</span></button>
   </nav><footer><BookOpen size={16}/><p>每条发现都保留依据。<br/>先理解，再决定下一步。</p></footer>
  </aside>}
  <div className="insights-page">
   {!desktop&&topbar}
   {desktop?<>
    {visitedSections.current.has("stageReview")&&<div className="insights-panel-slot" hidden={section!=="stageReview"}><StageReview onOpenWork={openWork}/></div>}
    {visitedSections.current.has("topic")&&<div className="insights-panel-slot" hidden={section!=="topic"}><InsightNotebookWorkspace generation={data.generation} kind="topic" query="" onOpenWork={openWork}/></div>}
    {visitedSections.current.has("draft")&&<div className="insights-panel-slot" hidden={section!=="draft"}><InsightNotebookWorkspace generation={data.generation} kind="draft" query="" onOpenWork={openWork}/></div>}
    {section==="decision"&&<InsightNotebookWorkspace key="decision" generation={data.generation} kind="decision" query="" onOpenWork={openWork}/>}
    {section==="cases"&&<InsightCases query="" onDraft={()=>navigate("draft")}/>}
    {section==="history"&&<InsightHistory key={data.generation} query="" label={eventLabel} onOpen={id=>{setSection("discoveries");void data.open(id);}}/>}
   </>:(section==="stageReview"?<StageReview onOpenWork={openWork}/>:section==="cases"?<InsightCases query={query} onDraft={()=>navigate("draft")}/>:section==="history"?<InsightHistory key={data.generation} query={query} label={eventLabel} onOpen={id=>{setSection("discoveries");void data.open(id);}}/>:["topic","draft","decision"].includes(section)?<InsightNotebookWorkspace key={section} generation={data.generation} kind={section as "topic"|"draft"|"decision"} query={query} onOpenWork={openWork}/>:null)}
   {section==="discoveries"&&<>
   {!desktop&&<header className="insights-heading"><div className="insights-title"><div className="insights-title-icon" aria-hidden="true"><Sparkles size={25}/></div><div><span className="insights-overline">让已有的积累，接着发挥作用</span><h1>洞察</h1><p>看见资料里的变化与关联，找到可以继续的一步。</p></div></div>{mainActions}</header>}
   {!desktop&&<div className="insights-controls">{statusTabs}<div className="insights-view-tools"><details className="insights-menu insights-filter-menu"><summary aria-label="筛选发现" className={filtered?"is-filtered":""}><SlidersHorizontal size={16}/><span>筛选</span>{filtered&&<b>{Number(days!==0)+Number(validity!=="all")+Number(!!workFilter)}</b>}</summary><div className="insights-filter-popover"><header><strong>筛选发现</strong><button type="button" onClick={()=>{setDays(0);setValidity("all");setWorkFilter("");}}>重置</button></header><label>关联事项<select aria-label="关联事项" value={workFilter} onChange={e=>setWorkFilter(e.target.value)}><option value="">全部事项</option>{[...new Set(data.items.map(i=>i.workId))].map(id=><option key={id} value={id}>{data.items.find(i=>i.workId===id)?.workTitle??id}</option>)}</select></label><label>时间范围<select aria-label="发现时间" value={days} onChange={e=>setDays(Number(e.target.value))}><option value={0}>全部时间</option><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option></select></label><label>结论有效性<select aria-label="结论有效性" value={validity} onChange={e=>setValidity(e.target.value)}><option value="all">全部结论</option><option value="available">依据已核对</option><option value="review">待复核</option><option value="unavailable">来源不可用</option></select></label><button type="button" className="insights-primary" onClick={e=>e.currentTarget.closest("details")?.removeAttribute("open")}>完成</button></div></details><span className="insights-toolbar-divider"/><div className="insights-layout-switch" aria-label="发现布局"><button type="button" aria-label="卡片浏览" aria-pressed={layout==="cards"} onClick={()=>setLayout("cards")}><LayoutGrid size={16}/></button><button type="button" aria-label="列表与详情" aria-pressed={layout==="split"} onClick={()=>setLayout("split")}><PanelRight size={16}/></button></div></div></div>}
   {data.error&&<p className="insights-error" role="alert">{data.error}</p>}
   {data.unresolved&&!data.busy&&<div className="insights-notice" role="status"><p>上一次操作的提交结果需要核对。</p><button type="button" onClick={()=>void data.inspectPending()}>核对提交结果</button><button type="button" onClick={()=>void data.retryPending().catch(()=>undefined)}>按原请求重试</button>{data.pendingChecked&&<button type="button" onClick={data.discardPending}>放弃未提交请求并刷新</button>}</div>}
   <div className={`insights-panels insights-layout-${layout}${data.detail?" has-detail":""}`} style={{"--insights-list-width":`${listWidth}px`} as CSSProperties}>
    <div className="insights-browse" ref={listPane}>
     {desktop?<div className="insights-list-header">
      <div className="insights-scope-pills" role="tablist" aria-label="快捷范围">
       <button type="button" role="tab" className={`insights-scope-pill${scope==="all"&&filter==="all"?" active":""}`} aria-selected={scope==="all"&&filter==="all"} onClick={()=>{setScope("all");setPerspectiveFilter("");setFilter("all");setCheckedIds([]);}}><span>全部</span><span className="insights-pill-num">{data.items.length}{data.more?"+":""}</span></button>
       <button type="button" role="tab" className={`insights-scope-pill${scope==="all"&&filter==="attention"?" active":""}`} aria-selected={scope==="all"&&filter==="attention"} onClick={()=>{setScope("all");setPerspectiveFilter("");setFilter("attention");setCheckedIds([]);}}><span>待关注</span><span className="insights-pill-num">{attentionCount}</span></button>
       <button type="button" role="tab" className={`insights-scope-pill${reviewCount>0?" has-review":""}${scope==="review"?" active":""}`} aria-selected={scope==="review"} onClick={()=>{setScope("review");setPerspectiveFilter("");setFilter("all");setCheckedIds([]);}}>{reviewCount>0&&<span className="insights-review-dot" aria-hidden="true"/>}<span>待复核</span><span className="insights-pill-num">{reviewCount}</span></button>
       <button type="button" role="tab" className={`insights-scope-pill${scope==="starred"?" active":""}`} aria-selected={scope==="starred"} onClick={()=>{setScope("starred");setPerspectiveFilter("");setFilter("all");setCheckedIds([]);}}><span>星标</span><span className="insights-pill-num">{starredCount}</span></button>
      </div>
      <div className="insights-filter-row">
       <div className="insights-filter-selects">
        <select className={`insights-mini-select${perspectiveFilter?" is-filtered":""}`} aria-label="按视角筛选" value={perspectiveFilter} onChange={e=>{const next=e.target.value as ""|"knowledge"|"life"|"decision";setPerspectiveFilter(next);if(["knowledge","life","decision"].includes(scope))setScope("all");setCheckedIds([]);}}>
         <option value="">全部视角</option>
         <option value="knowledge">知识与工作</option>
         <option value="decision">决定与变化</option>
         <option value="life">生活与进展</option>
        </select>
        <select className={`insights-mini-select${filter!=="all"?" is-filtered":""}`} aria-label="按处理状态筛选" value={filter} onChange={e=>{setFilter(e.target.value as typeof filter);setCheckedIds([]);}}>
         <option value="all">全部状态</option>
         <option value="attention">待关注</option>
         <option value="later">稍后</option>
         <option value="done">已处理</option>
        </select>
       </div>
       {desktopViewTools}
      </div>
     </div>:<div className="insights-list-heading"><h2>{scope==="review"?"需要重新核对":filter==="later"?"留给稍后的发现":filter==="done"?"已经留下的收获":filter==="all"?"全部已保存发现":"值得留意"}<span>{visible.length}{data.more?"+":""}</span></h2><span>每个发现，都能回到依据</span></div>}
     <div className={`insights-content${selectedRows.length?" has-selection":""}`} aria-busy={data.loading}>
      {layout==="cards"&&!query&&scope==="all"&&filter==="attention"&&<button type="button" className="insights-case-intro" onClick={()=>navigate("cases")}><span className="insights-case-intro-icon"><Globe2 size={22}/></span><span><strong>从一个真实案例，理解洞察</strong><small>5 个案例 · 官方资料、应用场景和可尝试的下一步</small></span><span className="insights-case-intro-link">浏览案例<ArrowUpRight size={16}/></span></button>}
      {!!selectedRows.length&&desktop&&<div className="insights-batch" aria-label="批量处理所选发现"><span>已选 {selectedRows.length} 条</span>
       <button type="button" disabled={!canBatch} onClick={()=>void applyBatch("done")}>批量标为已处理</button>
       <button type="button" disabled={!canBatch} onClick={()=>void applyBatch("later")}>批量稍后一天</button>
       <button type="button" disabled={!canBatch} onClick={()=>void applyBatch("unfollow")}>批量取消关注</button>
       <button type="button" className="icon-button" aria-label="清除选择" disabled={batchBusy} onClick={()=>setCheckedIds([])}><X size={15}/></button>
      </div>}{batchResult&&<p className="insights-batch-result" role="status">{batchResult}</p>}
      {data.loading&&!data.items.length?<p role="status">正在读取发现和核对依据…</p>:!visible.length?<div className="insights-empty"><Sparkles size={26}/><h2>{data.items.length?"没有符合筛选条件的发现":"从一份已有成果开始"}</h2><p>{data.items.length?"调整状态、时间或搜索条件，再看看其他发现。":"选择本地资料，直接发现可以用上的旧经验或值得留意的变化。"}</p><button type="button" onClick={()=>data.items.length?reset():setDiscovery({})}>{data.items.length?"显示全部发现":"开始发现"}</button></div>:layout==="table"?<div className="insights-table-scroll"><table className="insights-table"><thead><tr>
       <th scope="col"><input type="checkbox" aria-label="选择当前可操作发现" disabled={!canChoose||!visible.some(item=>item.snapshot&&!item.checking)} checked={visible.some(item=>item.snapshot&&!item.checking)&&visible.every(item=>!item.snapshot||item.checking||checkedIds.includes(item.id))} onChange={e=>setCheckedIds(e.target.checked?visible.filter(item=>item.snapshot&&!item.checking).map(item=>item.id):[])}/></th>
       <th scope="col">处理状态</th><th scope="col">洞察</th><th scope="col">依据状态</th><th scope="col">视角</th><th scope="col">版本</th><th scope="col">原事项</th><th scope="col">更新时间</th>
      </tr></thead><tbody>{visible.map(item=><tr key={item.id} className={data.detail?.id===item.id?"is-selected":undefined}>
       <td><input type="checkbox" aria-label="选择发现" disabled={!canChoose||!item.snapshot||item.checking} checked={checkedIds.includes(item.id)&&!!item.snapshot} onChange={()=>toggleRow(item.id)}/></td>
       <td><FindingStatus item={item}/></td>
       <td><button type="button" className="insights-table-open" aria-current={data.detail?.id===item.id||undefined} onClick={e=>{tableRowTrigger.current=e.currentTarget;openFinding(item);}}><span>{item.snapshot?findingPreview(item.snapshot.text).title:item.checking?"正在核对依据":"来源当前不可访问"}</span>{item.starred&&<Star size={13} fill="currentColor"/>}</button></td>
       <td><FindingValidity item={item}/></td><td>{perspectiveNames[item.perspective??""]??"—"}</td><td>v{item.headRevision}</td>
       <td><span className="insights-table-work" title={item.snapshot?item.workTitle:undefined}>{item.snapshot?(item.workTitle??"原事项"):"—"}</span></td><td><time dateTime={new Date(item.updatedAt).toISOString()}>{time(item.updatedAt)}</time></td>
      </tr>)}</tbody></table></div>:<div className="insights-grid">{visible.map(item=>{const preview=findingPreview(item.snapshot?.text??(item.checking?"正在核对这条发现的依据":"这条发现的来源当前不可访问"));return <article className={`insights-card${data.detail?.id===item.id?" is-current":""}${checkedIds.includes(item.id)?" is-checked":""}`} key={item.id}>{desktop&&layout==="split"&&<input className="insights-card-check" type="checkbox" aria-label="选择发现" disabled={!canChoose||!item.snapshot||item.checking} checked={checkedIds.includes(item.id)&&!!item.snapshot} onChange={()=>toggleRow(item.id)}/>}<div className="insights-card-main"><div className="insights-card-meta"><span className="insights-category" title={item.snapshot?item.workTitle:undefined}><Sparkles size={13}/>{desktop&&layout==="split"&&item.snapshot?.origin&&item.workTitle?item.workTitle:item.perspective?perspectiveNames[item.perspective]:item.snapshot?.reviewDependency?reviewNatureNames[item.snapshot.reviewDependency.nature]:"已保存发现"}</span>{item.validity!=="available"&&<span className={`insights-validity insights-validity-${item.validity}`}>{item.checking?"正在核对依据":validityNames[item.validity]}</span>}<time dateTime={new Date(item.updatedAt).toISOString()} title={time(item.updatedAt)}>{new Intl.DateTimeFormat("zh-CN",{month:"numeric",day:"numeric"}).format(item.updatedAt)}</time><button type="button" className="insights-star" aria-label={item.starred?"取消星标":"星标发现"} aria-pressed={!!item.starred} disabled={data.busy||!item.snapshot} onClick={()=>void data.change(item,"insightStar",{starred:!item.starred}).catch(()=>undefined)}><Star size={15} fill={item.starred?"currentColor":"none"}/></button></div><button type="button" className="insights-card-open" aria-label={item.snapshot?.text??"查看来源不可用的发现"} onClick={()=>openFinding(item)}><h2>{preview.title}</h2></button>{preview.body&&<p className="insights-card-summary">{preview.body}</p>}{desktop&&layout==="split"&&<div className="insights-stream-properties"><FindingStatus item={item}/><FindingValidity item={item}/><span>v{item.headRevision}</span></div>}<p className="insights-card-sources"><Layers3 size={14}/><span>{item.workTitle??item.snapshot?.sourceCitations.map(s=>s.excerpt.title).filter((v,i,a)=>a.indexOf(v)===i).join(" · ")??"用户处理记录与历史身份已保留"}</span></p>{(item.processingState!=="attention"||!item.followed)&&<p className="insights-card-state">{stateNames[item.processingState]}{!item.followed&&<> · <BellOff size={12}/>不再关注</>}</p>}</div><footer><span><Layers3 size={14}/>{item.snapshot?`${item.snapshot.sourceCitations.length+(item.snapshot.reviewDependency?.dependencies.filter(d=>d.kind==="userInput").length??0)} 处依据`:"正文已隐藏"}{item.headRevision>1?` · 修订 ${item.headRevision}`:""}</span><details className="insights-menu insights-card-menu"><summary aria-label="发现快捷操作"><MoreHorizontal size={17}/></summary><div className="insights-menu-content"><button type="button" disabled={data.busy||!item.snapshot} onClick={()=>setDiscovery({target:item})}>加入后续记录并核对</button><button type="button" disabled={data.busy||!item.snapshot} onClick={()=>openSnooze(item)}>选择稍后时间</button>{(["attention","later","done"] as const).map(state=><button type="button" key={state} disabled={data.busy||!item.snapshot} onClick={e=>{e.currentTarget.closest("details")?.removeAttribute("open");void data.change(item,"insightStatus",{state,...(state==="later"?{snoozeUntil:Date.now()+86400000}:{})}).catch(()=>undefined);}}>{stateNames[state]}{state==="later"?"一天":""}</button>)}</div></details><button type="button" onClick={()=>openFinding(item)}>{item.validity==="review"?"核对这条发现":"查看发现"}<ArrowUpRight size={14}/></button></footer></article>;})}</div>}
      {!desktop&&data.more&&<button type="button" className="insights-load-more" disabled={data.loading} onClick={()=>void data.refresh(true)}>再看更多发现<ChevronDown size={14}/></button>}
     </div>
     {desktop&&<div className="insights-list-footer"><div><span>共 {visible.length}{data.more?"+":""} 条发现</span>{hasActiveFilter&&<button type="button" className="insights-link-btn" onClick={reset}>重置筛选</button>}</div>{data.more&&<button type="button" className="insights-link-btn" disabled={data.loading} onClick={()=>void data.refresh(true)}>加载更多</button>}</div>}
    </div>
    {desktop&&layout==="split"&&<div className="insights-split-gutter" role="separator" aria-label="调整洞察列表宽度" aria-orientation="vertical"
     aria-valuemin={minimumListWidth} aria-valuemax={maximumListWidth} aria-valuenow={listWidth} tabIndex={0}
     title="拖动或用方向键调整，双击恢复默认" onDoubleClick={()=>{setListWidth(defaultListWidth);saveInsightsListWidth(defaultListWidth);}}
     onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.focus();event.currentTarget.setPointerCapture?.(event.pointerId);splitDrag.current={pointerId:event.pointerId,x:event.clientX,width:listPane.current?.offsetWidth||listWidth,dragged:false};}}
     onPointerMove={event=>{const drag=splitDrag.current;if(!drag||event.pointerId!==drag.pointerId)return;if(!drag.dragged){if(Math.abs(event.clientX-drag.x)<SPLIT_DRAG_THRESHOLD_PX)return;drag.dragged=true;document.body.classList.add("resizing-panes");}const next=clampListWidth(drag.width+event.clientX-drag.x);setListWidth(next);}}
     onPointerUp={event=>{const drag=splitDrag.current;if(!drag||event.pointerId!==drag.pointerId)return;if(drag.dragged){const next=clampListWidth(drag.width+event.clientX-drag.x);setListWidth(next);saveInsightsListWidth(next);}document.body.classList.remove("resizing-panes");if(event.currentTarget.hasPointerCapture?.(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);splitDrag.current=null;}}
     onPointerCancel={event=>{const drag=splitDrag.current;if(!drag||event.pointerId!==drag.pointerId)return;if(drag.dragged)saveInsightsListWidth(listWidth);document.body.classList.remove("resizing-panes");if(event.currentTarget.hasPointerCapture?.(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);splitDrag.current=null;}}
     onLostPointerCapture={()=>{document.body.classList.remove("resizing-panes");splitDrag.current=null;}}
     onKeyDown={event=>{if(event.key==="Home"){event.preventDefault();setListWidth(minimumListWidth);saveInsightsListWidth(minimumListWidth);return;}if(event.key==="End"){event.preventDefault();setListWidth(maximumListWidth);saveInsightsListWidth(maximumListWidth);return;}if(event.key==="Enter"){event.preventDefault();setListWidth(defaultListWidth);saveInsightsListWidth(defaultListWidth);return;}if(event.key!=="ArrowLeft"&&event.key!=="ArrowRight")return;event.preventDefault();const next=clampListWidth(listWidth+(event.key==="ArrowRight"?16:-16));setListWidth(next);saveInsightsListWidth(next);}}/>}
    {data.detail&&<InsightDetail key={data.detail.id} desktop={desktop} closeRef={layout==="table"?tableClose:undefined} onReview={()=>setDiscovery({target:data.detail!})} inline={layout!=="cards"&&(desktop||!focus)} onSnooze={()=>openSnooze(data.detail!)} initialFeedback={detailDrafts.current[data.detail.id]??""} onFeedback={value=>{detailDrafts.current[data.detail!.id]=value;}} focus={focus} onFocus={()=>setFocus(!focus)} onPrevious={position>0?()=>go(-1):undefined} onNext={position>=0&&position<visible.length-1?()=>go(1):undefined} data={data} item={data.detail} libraries={libraries} onOpenTask={onOpenTask} onClose={closeFinding} onUpdate={()=>setPicker({target:data.detail!})} onOpenWork={openWork}/>}
    {layout==="split"&&!data.detail&&<div className="insights-detail-empty"><Sparkles size={30}/><h2>从一条发现，接着看下去</h2><p>选择左侧发现，查看资料依据与处理记录。</p></div>}
   </div><p className="insights-footnote">{data.more?"当前数量仅含已载入发现 · ":""}保存在本机 · 资料按 Hub 当前同步内容核对 · 打开和筛选不会启动分析</p></>}
  </div>
  {decisions&&<InsightDialog title="决定与条件" wide onClose={()=>setDecisions(false)}><InsightNotebookWorkspace generation={data.generation} kind="decision" query="" onOpenWork={openWork}/></InsightDialog>}
  {snooze&&<InsightDialog title="什么时候再看？" onClose={()=>setSnooze(null)}><p className="insights-dialog-intro">稍后只控制这条发现出现的时间，不改变事实判断或原任务。</p><div className="insights-picker-body"><div className="insights-detail-actions">{[["两小时后",2],["明天此时",24],["一周后",168]].map(([name,h])=><button type="button" key={name} onClick={()=>setSnoozeDate(localDate(Number(h)))}>{name}</button>)}</div><label>明确的稍后时间<input type="datetime-local" value={snoozeDate} onChange={e=>setSnoozeDate(e.target.value)}/></label><p>到期后，在下一次打开面板时回到待关注。关闭期间不发送提醒。</p></div>{data.error&&<p role="alert">{data.error}</p>}<footer><button type="button" onClick={()=>setSnooze(null)}>取消</button><button type="button" disabled={data.busy||!snoozeDate||!Number.isFinite(new Date(snoozeDate).getTime())||new Date(snoozeDate).getTime()<=Date.now()} onClick={()=>void data.change(snooze,"insightStatus",{state:"later",snoozeUntil:new Date(snoozeDate).getTime()}).then(()=>setSnooze(null)).catch(()=>undefined)}>保存稍后时间</button></footer></InsightDialog>}
  {discovery&&<InsightDialog title="从当前事情，发现联系与变化" wide onClose={()=>setDiscovery(null)}><InsightDiscovery key={discovery.target?.id??"new"} data={data} target={discovery.target} onOpenWork={openWork} onView={item=>{setDiscovery(null);void data.open(item.id);}}/></InsightDialog>}
  {recall&&<InsightDialog title="寻找旧知识" onClose={()=>setRecall(false)}><InsightRecall data={data} onOpenWork={openWork}/></InsightDialog>}
  {picker&&<ResultPicker key={picker.target?.id??"import"} data={data} target={picker.target} onClose={()=>setPicker(null)} onOpenWork={openWork}/>}
 </section>;
}
