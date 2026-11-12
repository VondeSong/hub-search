import {useContext,useEffect,useMemo,useRef,useState,type ReactNode} from "react";
import {ArrowUpRight,Check,CheckCircle2,Clock3,FileText,History,MessageSquare,PanelLeft,Plus,RefreshCw,Search,Sparkles,Star,X} from "lucide-react";
import {useInsights} from "./useInsights";
import type {Insight,InsightCandidates,InsightDelivery,InsightEvent,InsightSource} from "./InsightTypes";
import type {WorkSummary} from "./AgentConversationHistoryData";
import {AgentPanelContext} from "./StandaloneAgentLauncher";
import {AgentCitationPreview} from "./AgentCitationPreview";
import "./InsightsWorkspace.css";

const stateNames={attention:"待关注",later:"稍后",done:"已处理"};
const validityNames={available:"依据已核对",review:"待复核",unavailable:"来源不可用"};
const reasonNames:Record<string,string>={sourceChanged:"资料内容已变化",sourceUnavailable:"资料已删除或撤回访问",feedback:"有待处理的用户纠正",restore:"恢复后需要核对来源",userContextChanged:"已采用的用户补充发生变化"};
const time=(at:number)=>new Intl.DateTimeFormat("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(at);
type Data=ReturnType<typeof useInsights>;

function InsightDialog({title,children,onClose,wide=false}:{title:string;children:ReactNode;onClose:()=>void;wide?:boolean}){
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const node=ref.current;if(node?.showModal)node.showModal();else if(node)node.open=true;return()=>{node?.close?.();};},[]);
 return <dialog ref={ref} className={`insights-dialog${wide?" insights-dialog-wide":""}`} aria-label={title} onCancel={event=>{event.preventDefault();onClose();}}>
  <header><h2>{title}</h2><button type="button" className="icon-button" aria-label="关闭对话框" onClick={onClose}><X size={19}/></button></header>{children}
 </dialog>;
}

function ResultPicker({data,target,onClose}:{data:Data;target?:Insight;onClose:()=>void}){
 const [works,setWorks]=useState<WorkSummary[]>([]),[workId,setWorkId]=useState(target?.workId??"");
 const [deliveries,setDeliveries]=useState<InsightDelivery[]>([]),[before,setBefore]=useState<string|null>(null),[deliveryId,setDeliveryId]=useState("");
 const [candidates,setCandidates]=useState<InsightCandidates|null>(null),[selected,setSelected]=useState<string[]>([]),[contexts,setContexts]=useState<string[]>([]),[checked,setChecked]=useState(false);
 const [feedbacks,setFeedbacks]=useState<string[]>([]),[error,setError]=useState(""),[loading,setLoading]=useState(true),[saved,setSaved]=useState(0),[workCursor,setWorkCursor]=useState<unknown>(null);
 const request=useRef(0);
 useEffect(()=>{let active=true;void data.selectWorks().then(v=>{if(!active)return;setWorks(v.works);setWorkCursor(v.nextCursor);if(!target)setWorkId(v.works[0]?.id??"");}).catch(e=>active&&setError(String(e))).finally(()=>active&&setLoading(false));return()=>{active=false;};},[]);
 useEffect(()=>{if(!workId)return;const ticket=++request.current;setLoading(true);setError("");setCandidates(null);setSelected([]);setDeliveries([]);setDeliveryId("");void data.deliveries(workId).then(v=>{if(ticket!==request.current)return;setDeliveries(v.items);setBefore(v.nextBeforeRecordId??null);setDeliveryId(v.items[0]?.deliveryRecordId??"");}).catch(e=>ticket===request.current&&setError(String(e))).finally(()=>ticket===request.current&&setLoading(false));return()=>{++request.current;};},[workId]);
 useEffect(()=>{if(!deliveryId)return;const ticket=++request.current;setLoading(true);setChecked(false);setContexts([]);setSelected([]);void data.candidates(workId,deliveryId).then(v=>{if(ticket===request.current)setCandidates(v);}).catch(e=>ticket===request.current&&setError(String(e))).finally(()=>ticket===request.current&&setLoading(false));return()=>{++request.current;};},[deliveryId]);
 const pendingFeedback=(target?.events??[]).filter(e=>e.kind==="insightFeedback"&&e.body?.kind==="correction"&&target?.reasons.some(r=>r.active&&r.kind==="feedback"&&r.reference?.feedbackId===e.id));
 const toggle=(values:string[],key:string)=>values.includes(key)?values.filter(v=>v!==key):[...values,key];
 const save=async()=>{
  if(!candidates)return;setError("");
  try{let count=0;for(const candidate of candidates.candidates.filter(v=>selected.includes(v.findingPointer))){await data.saveCandidate(candidates.origin,candidate,target,feedbacks,contexts);setSelected(old=>old.filter(v=>v!==candidate.findingPointer));++count;}setSaved(n=>n+count);await data.refresh();if(target)onClose();}
  catch(e){setError(String(e));}
 };
 return <InsightDialog title={target?"更新这条发现":"从已有成果保存发现"} onClose={onClose} wide>
  <p className="insights-dialog-intro">选择已发布、带可核对引用的结构化发现。浏览与保存不会启动分析。</p>
  <div className="insights-picker-controls"><label>事项<select aria-label="成果事项" value={workId} disabled={!!target||loading} onChange={e=>setWorkId(e.target.value)}><option value="">选择事项</option>{works.map(w=><option key={w.id} value={w.id}>{w.goal}</option>)}{target&&!works.some(w=>w.id===target.workId)&&<option value={target.workId}>原事项</option>}</select></label>
   {workCursor!=null&&!target&&<button type="button" onClick={()=>void data.selectWorks(workCursor).then(v=>{setWorks(old=>[...old,...v.works]);setWorkCursor(v.nextCursor);}).catch(e=>setError(String(e)))}>更多事项</button>}
   <label>已发布成果<select aria-label="选择固定成果" value={deliveryId} disabled={loading} onChange={e=>setDeliveryId(e.target.value)}><option value="">选择成果</option>{deliveries.map(d=><option key={d.deliveryRecordId} value={d.deliveryRecordId}>{time(d.generatedAt)} · {d.findingCount} 条候选</option>)}</select></label>
   {before&&<button type="button" disabled={loading} onClick={()=>void data.deliveries(workId,before).then(v=>{setDeliveries(old=>[...old,...v.items]);setBefore(v.nextBeforeRecordId??null);}).catch(e=>setError(String(e)))}>更早的成果</button>}
  </div>
  <div className="insights-picker-body" aria-busy={loading}>{loading?<p role="status">正在核对成果和当前依据…</p>:!workId?<p>尚无可选择的事项。先在 Hub 助手中分析授权资料，明确要求“给出有依据的结构化发现”。</p>:!deliveryId?<p>该事项尚无已发布成果，可在原事项中继续。</p>:candidates?.reason?<p role="status">{candidates.reason}</p>:candidates?.candidates.map(candidate=><div className="insights-candidate" key={candidate.findingPointer}>
   {candidate.eligibility==="unavailable"?<p className="insights-notice">{candidate.reason}</p>:<><label><input type={target?"radio":"checkbox"} name="insightCandidate" checked={selected.includes(candidate.findingPointer)} onChange={()=>setSelected(target?[candidate.findingPointer]:toggle(selected,candidate.findingPointer))}/><strong>{candidate.text}</strong></label>
    <div className="insights-source-list">{candidate.sourceCitations?.map((source,index)=><details key={index}><summary><FileText size={14}/>{source.excerpt.title} · 已核对版本</summary><blockquote>{source.quote}</blockquote><small>{source.excerpt.sourcePath} · 第 {source.excerpt.startChar+1}–{source.excerpt.endChar} 字符</small></details>)}</div></>}
   </div>)}
   {!!candidates?.candidates.some(v=>v.eligibility==="verifiedSources")&&<fieldset className="insights-background"><legend>影响判断的共同背景（如有）</legend><p>这里只列出本次成果实际读取且当前可用的材料；按选中发现的实际依赖选择。</p>{candidates.contextOptions?.map(context=><label key={context.evidenceId}><input type="checkbox" checked={contexts.includes(context.evidenceId)} onChange={()=>setContexts(toggle(contexts,context.evidenceId))}/>{context.title}</label>)}
    <label className="insights-confirm"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/>已核对所选发现的直接依据和必要背景</label></fieldset>}
   {!!pendingFeedback.length&&<fieldset className="insights-background"><legend>这次成果已按哪些补充修正</legend><p>只选择本次实际送入运行、并已在新结论中处理的补充；未选项继续待复核。</p>{pendingFeedback.map(f=><label key={f.id}><input type="checkbox" checked={feedbacks.includes(f.id)} onChange={()=>setFeedbacks(toggle(feedbacks,f.id))}/>{f.body?.text}</label>)}</fieldset>}
  </div>
  {error&&<p className="insights-error" role="alert">{error}</p>}{saved>0&&<p role="status">已保存 {saved} 条；重复选择不会新增发现或重置状态。</p>}
  <footer><button type="button" onClick={onClose}>取消</button><button type="button" className="insights-primary" disabled={!selected.length||!checked||data.busy||loading} onClick={()=>void save()}><Check size={16}/>{data.busy?"正在保存…":target?"确认更新这条发现":"保存所选发现"}</button></footer>
 </InsightDialog>;
}

function InsightDetail({data,item,onClose,onUpdate,onOpenWork}:{data:Data;item:Insight;onClose:()=>void;onUpdate:()=>void;onOpenWork:(id:string)=>void}){
 const [feedback,setFeedback]=useState(""),[kind,setKind]=useState("correction"),[source,setSource]=useState<InsightSource|null>(null),[error,setError]=useState(""),[sendFeedbackIds,setSendFeedbackIds]=useState<string[]>([]),[restoreConfirmed,setRestoreConfirmed]=useState(false);
 useEffect(()=>{if(item.checking||!item.snapshot)setSource(null);},[item.checking,item.snapshot]);
 const current=(item.contentRevision??item.headRevision)===item.headRevision;
 const act=(action:string,fields:Record<string,unknown>={})=>data.change(item,action,fields).catch(e=>setError(String(e)));
 const pending=item.events?.filter(e=>e.kind==="insightFeedback"&&e.body?.kind==="correction"&&item.reasons.some(r=>r.active&&r.kind==="feedback"&&r.reference?.feedbackId===e.id))??[];
 const lastStatus=[...(item.events??[])].reverse().find(e=>e.kind==="insightStatus");
 const submit=async()=>{try{await data.change(item,"insightFeedback",{text:feedback.trim(),kind});setFeedback("");}catch(e){setError(String(e));}};
 return <InsightDialog title="发现与依据" onClose={onClose} wide>
  <div className="insights-detail-body">{source&&item.snapshot&&!item.checking?<AgentCitationPreview value={{excerpt:source.excerpt,quote:source.quote??"",onReturn:()=>setSource(null)}}/>:<>
   <div className="insights-detail-meta"><span>{stateNames[item.processingState]}</span><span>{validityNames[item.validity]}</span><span>内容版本 {item.contentRevision??item.headRevision}</span><span>{time(item.updatedAt)}</span></div>
   {!item.snapshot?<section className="insights-notice"><p>{item.checking?"正在重新核对当前访问；未保存的补充已暂时保留。":item.restorePending?"这条发现来自恢复的备份。请重新确认原事项的资料访问，旧授权不会自动恢复。":"来源或原事项当前不可访问，已隐藏正文、引文与历史内容。"}</p>{item.restorePending&&<><button type="button" onClick={()=>onOpenWork(item.workId)}>到原事项查看资料范围</button><label className="insights-confirm"><input type="checkbox" checked={restoreConfirmed} onChange={e=>setRestoreConfirmed(e.target.checked)}/>我已核对当前本机资料的访问范围；远端最新状态仍需在来源库核对</label><button type="button" disabled={data.busy||!restoreConfirmed} onClick={()=>void act("insightRestoreAccess",{confirmCurrentAccess:true})}>重新确认原事项的本机访问</button></>}</section>:<>
    <div className="insights-finding-text">{item.snapshot.text}</div>{item.validity==="review"&&<div className="insights-notice" role="status">{item.reasons.filter(r=>r.active).map(r=><p key={r.id}>{reasonNames[r.kind]??"依据或适用条件需要重新核对"}</p>)}</div>}
    <div className="insights-detail-actions"><button type="button" onClick={()=>onOpenWork(item.workId)}><ArrowUpRight size={15}/>原事项</button><button type="button" disabled={!current||data.busy} onClick={()=>void act("insightFollow",{followed:!item.followed})}><Star size={15}/>{item.followed?"不再关注":"重新关注"}</button><button type="button" disabled={!current||data.busy} onClick={onUpdate}><RefreshCw size={15}/>选择新成果更新</button></div>
    <h4>资料依据</h4><p className="insights-muted">保存时的精确引文；查看原文时会再次核对当前权限和版本。</p>
    <div className="insights-source-list">{item.snapshot.sourceCitations.map((citation,index)=><article key={index}><strong>{citation.excerpt.title}</strong><blockquote>{citation.quote}</blockquote><button type="button" disabled={data.busy} onClick={()=>void data.source(item,index).then(setSource).catch(e=>setError(String(e)))}>查看引用原文 <ArrowUpRight size={13}/></button></article>)}</div>
    {!!item.snapshot.contextDependencies.length&&<section><h4>共同背景</h4>{item.snapshot.contextDependencies.map((context,index)=><p key={index}>{context.excerpt.title}</p>)}</section>}
    {!!item.snapshot.userContextRefs.length&&<section><h4>已采用的用户补充</h4>{item.snapshot.userContextRefs.map(ref=><blockquote key={ref.feedbackId}>{ref.text}<small>用户自述 · 经明确确认采用</small></blockquote>)}</section>}
    {current&&<section className="insights-feedback"><h4>补充与纠正</h4><label>反馈类型<select aria-label="反馈类型" value={kind} onChange={e=>setKind(e.target.value)}><option value="correction">事实或关联需要纠正</option><option value="notNeeded">现在不需要</option></select></label><label>你的补充<textarea aria-label="你的补充" rows={3} maxLength={3000} value={feedback} onChange={e=>setFeedback(e.target.value)} placeholder="说明哪一点需要补充或纠正…"/></label><button type="button" disabled={data.busy||!feedback.trim()} onClick={()=>void submit()}><MessageSquare size={15}/>保存反馈</button>
     {!!pending.length&&<div className="insights-review-action"><p>已保存 {pending.length} 条待处理纠正。选择本轮补充，在原事项中运行助手；生成后仍需选择新成果明确更新。</p>{pending.map(f=><label className="insights-feedback-choice" key={f.id}><input type="checkbox" checked={sendFeedbackIds.includes(f.id)} onChange={()=>setSendFeedbackIds(old=>old.includes(f.id)?old.filter(id=>id!==f.id):[...old,f.id])}/>{f.body?.text}</label>)}<button type="button" disabled={data.busy||!sendFeedbackIds.some(id=>pending.some(f=>f.id===id))} onClick={()=>void data.runReview(item,sendFeedbackIds.filter(id=>pending.some(f=>f.id===id)),onOpenWork).catch(e=>setError(String(e)))}><RefreshCw size={15}/>按补充继续核对</button></div>}
    </section>}
    <section><h4><History size={16}/>历史与用户记录</h4><label>查看内容版本<select aria-label="查看内容版本" value={item.contentRevision??item.headRevision} onChange={e=>void data.open(item.id,Number(e.target.value)).catch(e=>setError(String(e)))}>{Array.from({length:item.headRevision},(_,i)=>i+1).reverse().map(n=><option key={n} value={n}>版本 {n}{n===item.headRevision?"（当前）":""}</option>)}</select></label>
     <ol className="insights-events">{item.events?.map(event=><li key={event.id}><span>{time(event.createdAt)}</span><p>{event.restricted?"该修订当前不可访问":event.body?.text??eventLabel(event)}</p>{current&&!event.restricted&&event.kind==="insightFeedback"&&event.body?.kind==="correction"&&item.reasons.some(r=>r.active&&r.reference?.feedbackId===event.id)&&<button type="button" disabled={data.busy} onClick={()=>void act("insightWithdrawFeedback",{feedbackId:event.id})}>撤回这条纠正</button>}</li>)}</ol>
    </section>
   </>}
  </>}{error&&<p className="insights-error" role="alert">{error}</p>}</div>
  <footer>{item.snapshot&&current&&<><button type="button" disabled={data.busy} onClick={()=>void act("insightStatus",{state:"attention"})}>待关注</button><button type="button" disabled={data.busy} onClick={()=>void act("insightStatus",{state:"later",snoozeUntil:Date.now()+86_400_000})}><Clock3 size={15}/>稍后一天</button><button type="button" disabled={data.busy} onClick={()=>void act("insightStatus",{state:"done"})}><CheckCircle2 size={15}/>已处理</button>{lastStatus&&<button type="button" disabled={data.busy} onClick={()=>void act("insightUndoStatus",{eventId:lastStatus.id})}>撤销上次处理</button>}</>}<button type="button" onClick={onClose}>返回列表</button></footer>
 </InsightDialog>;
}
function eventLabel(event:InsightEvent){const labels:Record<string,string>={content:"保存了内容修订",existingOrigin:"确认了已有出处",reconcile:"核对了来源和出现时间",restore:"恢复后等待来源校验",insightStatus:"更新了处理状态",insightContinue:"将所选反馈送入原事项",insightWithdrawFeedback:"撤回了纠正，保留历史与依赖影响",insightFollow:"更新了关注设置",insightRelate:"关联了替代关系",insightUndoStatus:"撤销了处理动作"};return labels[event.kind]??"保存了用户操作";}

export function InsightsWorkspace({onToggleDesktopSidebar}:{onToggleDesktopSidebar?:()=>void}){
 const data=useInsights(),openAgent=useContext(AgentPanelContext);
 const [filter,setFilter]=useState<Insight["processingState"]|"all">("attention"),[query,setQuery]=useState(""),[days,setDays]=useState(0),[picker,setPicker]=useState<{target?:Insight}|null>(null);
 useEffect(()=>setPicker(null),[data.generation]);
 const openWork=(id:string)=>{data.closeDetail();setPicker(null);openAgent?.({workId:id});};
 const visible=useMemo(()=>data.items.filter(item=>(filter==="all"||item.processingState===filter)&&(!days||item.createdAt>=Date.now()-days*86_400_000)&&(!query.trim()||item.snapshot?.text.toLowerCase().includes(query.trim().toLowerCase())||item.snapshot?.sourceCitations.some(s=>s.excerpt.title.includes(query.trim())))),[data.items,filter,query,days]);
 return <section className="insights-workspace" aria-label="洞察发现工作区">
  <header className="insights-heading"><div><div className="insights-title">{onToggleDesktopSidebar&&<button type="button" className="icon-button" aria-label="切换洞察侧边栏" onClick={onToggleDesktopSidebar}><PanelLeft size={19}/></button>}<h1>洞察</h1></div><p>看见资料里的变化与关联，保留依据，继续核对。</p></div><div><button type="button" className="icon-button" aria-label="核对当前来源" disabled={data.loading||data.busy} onClick={()=>void data.refresh()}><RefreshCw size={17}/></button><button type="button" className="insights-primary" onClick={()=>setPicker({})}><Plus size={16}/>选择已有成果</button></div></header>
  <div className="insights-controls"><div className="insights-tabs" role="tablist" aria-label="发现处理状态">{(["attention","later","done","all"] as const).map(state=><button type="button" key={state} role="tab" aria-selected={filter===state} onClick={()=>setFilter(state)}>{state==="all"?"全部":stateNames[state]}<span>{data.items.filter(i=>state==="all"||i.processingState===state).length}</span></button>)}</div><label className="insights-search"><Search size={16}/><input aria-label="搜索发现与依据" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索发现与依据"/></label><select aria-label="发现时间" value={days} onChange={e=>setDays(Number(e.target.value))}><option value={0}>全部时间</option><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option></select></div>
  {data.error&&<p className="insights-error" role="alert">{data.error}</p>}
  {data.unresolved&&!data.busy&&<div className="insights-notice" role="status"><p>上一次操作的提交结果需要核对。</p><button type="button" onClick={()=>void data.inspectPending()}>核对提交结果</button><button type="button" onClick={()=>void data.retryPending().catch(()=>undefined)}>按原请求重试</button>{data.pendingChecked&&<button type="button" onClick={data.discardPending}>放弃未提交请求并刷新</button>}</div>}
  <div className="insights-content" aria-busy={data.loading}>{data.loading&&!data.items.length?<p role="status">正在读取发现和核对依据…</p>:!visible.length?<div className="insights-empty"><Sparkles size={26}/><h2>{data.items.length?"没有符合筛选条件的发现":"从一份已有成果开始"}</h2><p>{data.items.length?"调整状态、时间或搜索条件，再看看其他发现。":"先在 Hub 助手分析选定资料，再选择有依据的结构化发现保存到这里。"}</p><button type="button" onClick={()=>data.items.length?(setFilter("all"),setQuery(""),setDays(0)):setPicker({})}>{data.items.length?"显示全部发现":"选择已有成果"}</button></div>:<div className="insights-grid">{visible.map(item=><article className="insights-card" key={item.id}><div className="insights-card-meta"><span>{stateNames[item.processingState]}</span><span className={`insights-validity insights-validity-${item.validity}`}>{validityNames[item.validity]}</span><time>{time(item.createdAt)}</time></div><button type="button" className="insights-card-open" aria-label={item.snapshot?.text??"查看来源不可用的发现"} onClick={()=>void data.open(item.id).catch(()=>undefined)}><h2>{item.snapshot?.text??"这条发现的来源当前不可访问"}</h2></button><p className="insights-card-sources">{item.snapshot?.sourceCitations.map(s=>s.excerpt.title).filter((v,i,a)=>a.indexOf(v)===i).join(" · ")??"用户处理记录与历史身份已保留"}</p><footer><span>{item.snapshot?`${item.snapshot.sourceCitations.length} 处依据` : "正文已隐藏"}{!item.followed?" · 不再关注":""}</span><button type="button" onClick={()=>void data.open(item.id).catch(()=>undefined)}>{item.validity==="review"?"核对这条发现":"查看发现"}<ArrowUpRight size={14}/></button></footer></article>)}</div>}
   {data.more&&<button type="button" className="insights-load-more" disabled={data.loading} onClick={()=>void data.refresh(true)}>再看更多发现</button>}
  </div>
  <p className="insights-footnote">保存在本机 · 资料按 Hub 当前同步内容核对 · 打开和筛选不会启动分析</p>
  {picker&&<ResultPicker key={picker.target?.id??"import"} data={data} target={picker.target} onClose={()=>setPicker(null)}/>}
  {data.detail&&!picker&&<InsightDetail key={data.detail.id} data={data} item={data.detail} onClose={data.closeDetail} onUpdate={()=>setPicker({target:data.detail!})} onOpenWork={openWork}/>}
 </section>;
}
