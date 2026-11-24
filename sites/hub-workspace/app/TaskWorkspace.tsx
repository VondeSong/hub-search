"use client";
import {useEffect,useRef,useState} from "react";
import TaskAnalysis from './TaskAnalysis';
import {applyLocalAdvice,emptyAnalysisMemory,parseAnalysisMemory,setWaitingCondition,toggleTodayPlan,type AnalysisMemory,type AnalysisMode,type AnalysisRequest,type AnalysisTask,type TaskAdvice,type TaskEvidence} from './task-analysis-model';
import './task-analysis.css';
import {Sparkles,CalendarCheck,Target,Clock3,BookOpen,CheckCircle2,Circle} from 'lucide-react';
import {List,Columns3,CalendarRange,GitBranch,Network,PanelRight,RefreshCw,SlidersHorizontal,Table2,MoreHorizontal,Search,Plus,Check,ArrowLeft,ArrowUpRight,FileText,X,ChevronDown,ChevronRight,PanelLeft} from "lucide-react";
import {useDidaTasks} from "./useDidaTasks";
import {didaTasks,taskStates,taskProject,taskDate,taskStatus,taskResources,type TaskState} from "./task-data";
import {nodeById,libraries,pathOf,contentOf,type LibraryNode} from "./library-data";
import type {HubItem} from "./data";
import type {AssistantContext} from "./Assistant";

const modes=[{id:"list",name:"列表",icon:List},{id:"board",name:"看板",icon:Columns3},{id:"table",name:"表格",icon:Table2},{id:"timeline",name:"时间线",icon:CalendarRange},{id:"tree",name:"任务拆解图",icon:GitBranch},{id:"relations",name:"资料关联图",icon:Network}];
type Task=AnalysisTask;
type FocusLens="focus"|"open"|"done";
const TODAY_POOL_LIMIT=5;

export default function TaskWorkspace({initialTaskId,items,onUpdate,onNew,onLocate,onOpenAnalysis,onDiscussAnalysis,navigationOpen,onToggleNavigation,navigationResizer}:{initialTaskId?:string;items:HubItem[];onUpdate:(id:string,change:Partial<HubItem>)=>void;onNew:()=>void;onLocate:(id:string)=>void;onOpenAnalysis?:(item:HubItem)=>void;onDiscussAnalysis:(context:AssistantContext)=>void;navigationOpen:boolean;navigationResizer?:React.ReactNode;onToggleNavigation:()=>void}){
 const [detailOpen,setDetailOpen]=useState(false);
 const shared=useDidaTasks(),[mode,setMode]=useState("list"),[scope,setScope]=useState("all"),[query,setQuery]=useState(""),[selected,setSelected]=useState("d-review"),[resource,setResource]=useState(""),[mobileDetail,setMobileDetail]=useState(false),[collapsed,setCollapsed]=useState<string[]>([]);
 const [focusLens,setFocusLens]=useState<FocusLens>("focus");
 const [serifReading,setSerifReading]=useState(false);
 const [waitingEditorId,setWaitingEditorId]=useState<string|null>(null);
 const [waitingPerson,setWaitingPerson]=useState(""),[waitingReason,setWaitingReason]=useState(""),[waitingReviewDate,setWaitingReviewDate]=useState("");

 const [sourceFilter,setSourceFilter]=useState("全部"),[statusFilter,setStatusFilter]=useState("open"),[filterOpen,setFilterOpen]=useState(false),[searchOpen,setSearchOpen]=useState(false),[sort,setSort]=useState("default");
 const [notice,setNotice]=useState("");
 const [analysis,setAnalysis]=useState<AnalysisRequest|null>(null),[todayOnly,setTodayOnly]=useState(false),[analysisMemory,setAnalysisMemory]=useState<AnalysisMemory>(emptyAnalysisMemory);
 const memoryRef=useRef(analysisMemory),memoryWritable=useRef(true),analysisId=useRef(Date.now());
 const today=(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;})();

 useEffect(()=>{if(initialTaskId){setSelected(initialTaskId);setScope("all");setSourceFilter("全部");setStatusFilter("all");setFocusLens("open");setDetailOpen(true);setMobileDetail(true);}},[initialTaskId]);
 useEffect(()=>{try{const data=parseAnalysisMemory(localStorage.getItem('hub-task-analysis-v1'));if(!data)throw new Error();memoryRef.current=data;setAnalysisMemory(data);}catch{memoryWritable.current=false;setNotice('AI 计划记录暂时无法读取，已保留旧存档；任务列表仍可使用。');}},[]);

 function saveAnalysisMemory(next:AnalysisMemory){if(!memoryWritable.current)return false;try{localStorage.setItem('hub-task-analysis-v1',JSON.stringify(next));memoryRef.current=next;setAnalysisMemory(next);return true;}catch{return false;}}
 function adoptAdvice(advice:TaskAdvice,beforeText?:string){const next=applyLocalAdvice(memoryRef.current,advice,today,new Date().toISOString(),beforeText);return saveAnalysisMemory(next)?'':advice.kind==='source'?'任务说明已模拟更新，但采纳记录未能保存；请勿重复提交。':'浏览器未能保存计划或笔记，请检查存储后再试。';}
 function handleToggleToday(taskId:string){
  const isAlreadyToday=memoryRef.current.today[taskId]===today;
  const next=toggleTodayPlan(memoryRef.current,taskId,today);
  if(saveAnalysisMemory(next))setNotice(isAlreadyToday?'已移出今日计划（原任务日期与清单不变）':'已加入今日计划（仅本地聚焦引用，不修改来源）');
 }
 function openWaitingEditor(task:Task){
  const existing=analysisMemory.waiting?.[task.id];
  setWaitingPerson(existing?.person||'');
  setWaitingReason(existing?.reason||'');
  setWaitingReviewDate(existing?.reviewDate||'');
  setWaitingEditorId(task.id);
 }
 function commitWaitingCondition(task:Task){
  const next=setWaitingCondition(memoryRef.current,task.id,{person:waitingPerson,reason:waitingReason,reviewDate:waitingReviewDate||undefined});
  saveAnalysisMemory(next);
  if(task.status!=='waiting')status(task,'waiting');
  setWaitingEditorId(null);
  setNotice('已记录等待对象与回看条件');
 }
 function clearWaitingCondition(task:Task){
  const next=setWaitingCondition(memoryRef.current,task.id,null);
  saveAnalysisMemory(next);
  if(task.status==='waiting')status(task,'doing');
  setWaitingEditorId(null);
  setNotice('等待条件已满足，任务恢复进行中');
 }

 const [prefs,setPrefs]=useState<Record<string,{source:string;status:string;sort:string}>>({}),[viewsReady,setViewsReady]=useState(false);
 useEffect(()=>{try{const saved=JSON.parse(localStorage.getItem("hub-task-native-views-v1")||"null");if(saved){setPrefs(saved.prefs||{});const v=saved.prefs?.list;if(v&&!initialTaskId){setSourceFilter(v.source);setStatusFilter(v.status);setSort(v.sort);}}}catch{}setViewsReady(true);},[]);
 useEffect(()=>{if(viewsReady)try{localStorage.setItem("hub-task-native-views-v1",JSON.stringify({prefs:{...prefs,[mode]:{source:sourceFilter,status:statusFilter,sort}}}));}catch{}},[viewsReady,prefs,mode,sourceFilter,statusFilter,sort]);
 function chooseMode(id:string){setPrefs(old=>({...old,[mode]:{source:sourceFilter,status:statusFilter,sort}}));setMode(id);setMobileDetail(false);}
 function refresh(){window.dispatchEvent(new Event("hub-dida-task-demo-change"));setNotice("已重新读取浏览器中的示例任务；真实来源同步尚未连接。");}

 const sourceName=(s:string)=>s==="craft"?"Craft":s==="obsidian"?"Obsidian":s==="ticktick"?"滴答清单":"Hub";
 const tasks:Task[]=[...didaTasks.map(n=>({id:n.id,title:n.title,description:shared.descriptions[n.id]??n.description??"",project:taskProject(n.id),parent:nodeById[n.parent]?.kind==="task"?n.parent:"",priority:n.priority,date:taskDate(n.id,shared.dates),status:taskStatus(n.id,shared.checks,shared.status),source:"滴答清单"})),...items.filter(n=>n.kind==="task").map(n=>({id:n.id,title:n.title,description:n.excerpt,project:n.project||"个人",parent:"",date:n.due||"",status:n.taskState||"todo",source:sourceName(n.source)}))];
 const collectionKey=(t:Task)=>t.source+"::"+t.project;
 const collectionLibrary=(source:string)=>source==="Craft"?"Car":source==="Obsidian"?"OS":source;
 const collections=[...new Set(tasks.map(collectionKey))].map(key=>{const t=tasks.find(t=>collectionKey(t)===key)!;return {key,name:t.project,source:t.source,library:collectionLibrary(t.source),count:tasks.filter(t=>collectionKey(t)===key&&t.status!=="done").length};}).sort((a,b)=>a.name.localeCompare(b.name,"zh-CN"));

 function clearFilters(){setScope("all");setSourceFilter("全部");setStatusFilter(focusLens==="done"?"done":"open");setQuery("");setTodayOnly(false);setMobileDetail(false);}
 function selectLens(lens:FocusLens){
  setFocusLens(lens);
  setTodayOnly(false);
  if(lens==="done")setStatusFilter("done");
  else setStatusFilter("open");
 }

 const effectiveStatus=focusLens==="done"?"done":focusLens==="focus"?"open":statusFilter;
 const matches=(t:Task)=>(!todayOnly||analysisMemory.today[t.id]===today)&&(scope==="all"||scope==="unscheduled"&&!t.date||scope==="done"&&t.status==="done"||collectionKey(t)===scope)&&(sourceFilter==="全部"||t.source===sourceFilter)&&(effectiveStatus==="all"||(effectiveStatus==="done"?t.status==="done":t.status!=="done"))&&[t.title,t.description,t.project].join(" ").toLowerCase().includes(query.toLowerCase());
 const visible=tasks.filter(matches).sort((a,b)=>sort==="title"?a.title.localeCompare(b.title,"zh-CN"):sort==="date"?(a.date||"9999-12-31").localeCompare(b.date||"9999-12-31"):0);
 const current=tasks.find(t=>t.id===selected)||visible[0];
 const document=resource?nodeById[resource]:undefined;

 // Today Focus three-tier grouping (only active when focusLens === "focus" && mode === "list" && !query)
 const isFocusThreeTier=focusLens==="focus"&&mode==="list"&&!query.trim()&&!todayOnly;
 const dueTodayTasks=visible.filter(t=>t.status!=="done"&&t.status!=="waiting"&&Boolean(t.date)&&t.date<=today);
 const dueIdSet=new Set(dueTodayTasks.map(t=>t.id));
 const plannedTodayTasks=visible.filter(t=>t.status!=="done"&&t.status!=="waiting"&&!dueIdSet.has(t.id)&&analysisMemory.today[t.id]===today);
 const plannedIdSet=new Set(plannedTodayTasks.map(t=>t.id));
 const waitingTasks=visible.filter(t=>t.status==="waiting"||Boolean(analysisMemory.waiting?.[t.id]&&t.status!=="done"));
 const waitingIdSet=new Set(waitingTasks.map(t=>t.id));
 const backlogTasks=visible.filter(t=>t.status!=="done"&&!dueIdSet.has(t.id)&&!plannedIdSet.has(t.id)&&!waitingIdSet.has(t.id));

 const openTotal=tasks.filter(t=>t.status!=="done").length;
 const doneTotal=tasks.filter(t=>t.status==="done").length;
 const focusCount=tasks.filter(t=>t.status!=="done"&&((Boolean(t.date)&&t.date<=today)||analysisMemory.today[t.id]===today||t.status==="waiting")).length;

 function status(t:Task,value:TaskState){if(nodeById[t.id])shared.setStatus(t.id,value);else onUpdate(t.id,{taskState:value});}
 function date(t:Task,value:string){if(nodeById[t.id])shared.setDate(t.id,value);else onUpdate(t.id,{due:value});}
 function pick(t:Task){setAnalysis(null);setDetailOpen(true);setSelected(t.id);setResource("");setWaitingEditorId(null);setMobileDetail(true);if(window.innerWidth<1100&&navigationOpen)onToggleNavigation();}
 function beginAnalysis(kind:AnalysisMode,task?:Task,projectKey?:string){
  const key=projectKey||(scope!=='all'?scope:task?collectionKey(task):current?collectionKey(current):'');
  const chosen=kind==='task'?(task?[task]:current?[current]:[]):kind==='project'?tasks.filter(t=>collectionKey(t)===key):visible;
  const label=kind==='task'?chosen[0]?.title||'请选择任务':kind==='project'?`${chosen[0]?.source||''} / ${chosen[0]?.project||'请选择项目'}`:`当前列表${scope!=='all'?' · '+(collections.find(c=>c.key===scope)?.name||scope):' · 全部项目'}${sourceFilter!=='全部'?' · '+sourceFilter:''}${query?' · 搜索「'+query+'」':''}${todayOnly?' · 今日计划':''}`;
  if(kind==='project'&&key){setScope(key);setSourceFilter('全部');setStatusFilter('all');setFocusLens('open');setQuery('');setTodayOnly(false);}
  setAnalysis({id:++analysisId.current,mode:kind,label,taskIds:chosen.map(t=>t.id)});setDetailOpen(false);setResource('');setMobileDetail(true);if(task)setSelected(task.id);if(window.innerWidth<1100&&navigationOpen)onToggleNavigation();
 }
 const evidence:Record<string,TaskEvidence[]>=Object.fromEntries(tasks.map(t=>[t.id,taskResources.filter(r=>r.task===t.id).map(r=>{const n=nodeById[r.resource];return {id:n.id,title:n.title,source:libraries[n.library].provider,text:[n.description,...(contentOf(n).sections||[]).map(s=>s.text||s.items?.join('；'))].filter(Boolean).join('\n')};})]));
 function showAnalysisTask(id:string){const task=tasks.find(t=>t.id===id);if(!task)return;if(!visible.some(t=>t.id===id)){setScope("all");setSourceFilter("全部");setFocusLens("open");setStatusFilter("all");setQuery("");setTodayOnly(false);}pick(task);}
 function chooseScope(value:string){setScope(value);setResource("");setMobileDetail(false);if(window.innerWidth<1100&&navigationOpen)onToggleNavigation();}

 function formatShortDate(raw:string){
  if(!raw)return "";
  if(raw===today)return "今天";
  return raw.slice(5).replace("-","/");
 }

 const row=(t:Task)=>{
  const isToday=analysisMemory.today[t.id]===today;
  const isOverdue=Boolean(t.date)&&t.date<today&&t.status!=="done";
  const isDueToday=Boolean(t.date)&&t.date===today&&t.status!=="done";
  const waitInfo=analysisMemory.waiting?.[t.id];
  const refCount=(evidence[t.id]||[]).length;
  return <div key={t.id} className={"tw-task "+(selected===t.id?"selected ":"")+(t.status==="done"?"done":"")}>
   <button type="button" className={"tw-check-btn "+(t.status==="done"?"checked":"")} role="checkbox" aria-checked={t.status==="done"} aria-label={"完成任务 "+t.title} onClick={()=>status(t,t.status==="done"?"todo":"done")}>{t.status==="done"?<CheckCircle2 size={17}/>:<Circle size={17}/>}</button>
   <button className="tw-row-main" onClick={()=>pick(t)}>
    <span className="tw-row-title-line">
     <strong>{t.title}</strong>
     {isToday&&t.status!=="done"&&<em className="ta-today-mark">今日计划</em>}
     {t.status==="waiting"&&<em className="ta-wait-mark">等待{waitInfo?.person?` · ${waitInfo.person}`:""}</em>}
     {analysisMemory.notes[t.id]&&<em className="ta-note-mark">AI 笔记</em>}
    </span>
    <small>{t.parent?"子任务 · ":""}{t.project} · {t.source}{refCount>0?` · ${refCount} 份依据`:""}</small>
   </button>
   <div className="tw-row-hover-actions">
    {t.status!=="done"&&<button type="button" className={"tw-hover-btn "+(isToday?"active":"")} title={isToday?"移出今日计划":"加入今日计划"} aria-label={(isToday?"移出今日计划：":"加入今日计划：")+t.title} onClick={e=>{e.stopPropagation();handleToggleToday(t.id);}}><Target size={13}/><span>{isToday?"移出今日":"今日"}</span></button>}
    <button type="button" className="ta-analyze-row tw-hover-btn" aria-label={'分析任务：'+t.title} disabled={t.status==='done'} onClick={e=>{e.stopPropagation();beginAnalysis('task',t);}} title="围绕这条原任务分析"><Sparkles size={13}/><span>推进</span></button>
    {nodeById[t.id]&&<button type="button" className="tw-hover-btn" title="定位到来源结构" aria-label={"定位来源："+t.title} onClick={e=>{e.stopPropagation();onLocate(t.id);}}><ArrowUpRight size={13}/></button>}
   </div>
   <span className={"tw-date "+(isOverdue?"overdue":isDueToday?"due-today":"")}>{t.date?formatShortDate(t.date):""}</span>
  </div>;
 };

 const branch=(t:Task,depth=0):React.ReactNode=>{const children=tasks.filter(c=>c.parent===t.id&&visible.some(v=>v.id===c.id));return <li key={t.id}><div className="tw-branch-node">{children.length>0&&<button aria-label={(collapsed.includes(t.id)?"展开":"折叠")+t.title} onClick={()=>setCollapsed(old=>old.includes(t.id)?old.filter(id=>id!==t.id):[...old,t.id])}>{collapsed.includes(t.id)?<ChevronRight size={14}/>:<ChevronDown size={14}/>}</button>}<button aria-pressed={selected===t.id} onClick={()=>pick(t)}><span>{t.title}</span><small>{taskStates[t.status]} · {t.source}</small></button></div>{children.length>0&&!collapsed.includes(t.id)&&<ul>{children.map(child=>branch(child,depth+1))}</ul>}</li>;};
 const related=taskResources.filter(r=>r.task===current?.id);
 const activeWaitInfo=current?analysisMemory.waiting?.[current.id]:undefined;
 const isCurrentToday=current?analysisMemory.today[current.id]===today:false;

 return <div className={"task-demo task-v2-surface "+(navigationOpen?"nav-open ":"")+(mobileDetail?"tw-mobile-detail":"")}>
  <aside id="hub-module-navigation" className="tw-navigation task-module-sidebar" aria-label="任务导航">
   <header><strong>任务</strong><span className="tabular-nums">{openTotal}</span><button className="tw-mobile-close" aria-label="关闭任务导航" onClick={onToggleNavigation}><X size={16}/></button></header>
   <section aria-label="任务项目与清单">
    <h2>项目与清单</h2>
    <button aria-current={scope==="all"?"page":undefined} onClick={()=>chooseScope("all")}><List size={15}/><span>全部项目与清单</span><small className="tabular-nums">{openTotal}</small></button>
    {collections.map(c=><div className="ta-project-entry" key={c.key}><button aria-current={scope===c.key?"page":undefined} onClick={()=>chooseScope(c.key)} title={c.name+" · "+c.library}><span>{c.name}<em>{c.library}</em></span><small className="tabular-nums">{c.count}</small></button><button className="ta-project-analyze" aria-label={'梳理项目：'+c.library+' / '+c.name} onClick={()=>beginAnalysis('project',undefined,c.key)} title="分析这个项目的原任务"><Sparkles size={13}/></button></div>)}
   </section>
   <footer className="tw-sidebar-telemetry" title="原型本地存储边界">
    <span className="tw-telemetry-dot"/>
    <span className="tabular-nums">本地示例 · 3 来源 · {tasks.length} 项</span>
   </footer>
  </aside>{navigationResizer}
  {navigationOpen&&<button className="tw-scrim" aria-label="关闭任务导航遮罩" onClick={onToggleNavigation}/>}

  <main className="tw-main task-local-aligned">
   {/* Single-line inline toolbar (Notion減法 + Apple HIG) */}
   <header className="ta-single-toolbar">
    <div className="ta-toolbar-left">
     <button className="ta-nav-toggle" aria-label="切换任务导航" onClick={onToggleNavigation}><PanelLeft size={16}/></button>
     <div className="ta-lens-pills" role="tablist" aria-label="任务视角">
      <button type="button" role="tab" aria-selected={focusLens==="focus"} className={focusLens==="focus"?"active":""} onClick={()=>selectLens("focus")}>今日聚焦<span className="tabular-nums">{focusCount}</span></button>
      <button type="button" role="tab" aria-selected={focusLens==="open"} className={focusLens==="open"?"active":""} onClick={()=>selectLens("open")}>待办<span className="tabular-nums">{openTotal}</span></button>
      <button type="button" role="tab" aria-selected={focusLens==="done"} className={focusLens==="done"?"active":""} onClick={()=>selectLens("done")}>已完成<span className="tabular-nums">{doneTotal}</span></button>
     </div>
     <span className="ta-toolbar-sep" aria-hidden="true"/>
     <div className="ta-source-pills" aria-label="按来源筛选">
      {["全部","滴答清单","Craft","Obsidian"].map(source=><button key={source} className={"ta-source-pill "+(sourceFilter===source?"active":"")} onClick={()=>setSourceFilter(source)}>{source==="滴答清单"?"滴答":source}<small className="tabular-nums">{tasks.filter(t=>(focusLens==="done"?t.status==="done":t.status!=="done")&&(source==="全部"||t.source===source)).length}</small></button>)}
     </div>
    </div>

    <div className="ta-toolbar-right">
     {searchOpen ? (
      <label className="ta-inline-search"><Search size={13}/><input autoFocus aria-label="搜索任务内容" placeholder="搜索任务…" value={query} onChange={e=>setQuery(e.target.value)}/><button type="button" aria-label="关闭搜索" onClick={()=>{setQuery("");setSearchOpen(false);}}><X size={12}/></button></label>
     ) : (
      <button type="button" className="ta-icon-btn" aria-label="搜索任务" title="搜索任务" onClick={()=>setSearchOpen(true)}><Search size={15}/></button>
     )}

     <details className="ta-popover-menu">
      <summary className="ta-icon-btn" aria-label="视图与排序" title="视图与排序"><SlidersHorizontal size={15}/></summary>
      <div className="ta-popover-panel">
       <div className="ta-popover-section">展示布局</div>
       <div className="ta-layout-grid">
        {modes.map(m=><button key={m.id} type="button" className={mode===m.id?"active":""} onClick={e=>{chooseMode(m.id);e.currentTarget.closest("details")?.removeAttribute("open");}}><m.icon size={13}/><span>{m.name}</span></button>)}
       </div>
       <div className="ta-popover-section">排序方式</div>
       <select aria-label="任务排序" value={sort} onChange={e=>setSort(e.target.value)}><option value="default">默认顺序</option><option value="date">按到期日期</option><option value="title">按任务名称</option></select>
       <div className="ta-popover-section">更多操作</div>
       <button type="button" className="ta-popover-action" onClick={e=>{refresh();e.currentTarget.closest("details")?.removeAttribute("open");}}><RefreshCw size={13}/>刷新示例数据</button>
       <button type="button" className="ta-popover-action" onClick={e=>{onNew();e.currentTarget.closest("details")?.removeAttribute("open");}}><Plus size={13}/>添加示例任务</button>
      </div>
     </details>

     <details className="ta-popover-menu ta-ai-menu">
      <summary className="ta-primary-action-pill" aria-label="AI 任务规划"><Sparkles size={13}/><span>AI 规划</span><ChevronDown size={12}/></summary>
      <div className="ta-popover-panel">
       <div className="ta-popover-section">围绕原任务分析</div>
       <button type="button" className="ta-popover-action" onClick={e=>{beginAnalysis('today');e.currentTarget.closest("details")?.removeAttribute("open");}}><CalendarCheck size={13}/>安排今天（生成今日建议）</button>
       <button type="button" className="ta-popover-action" disabled={!collections.length} onClick={e=>{beginAnalysis('project');e.currentTarget.closest("details")?.removeAttribute("open");}}><Sparkles size={13}/>梳理当前项目</button>
       <button type="button" className="ta-popover-action" disabled={!current||current.status==='done'} onClick={e=>{beginAnalysis('task',current);e.currentTarget.closest("details")?.removeAttribute("open");}}><ArrowUpRight size={13}/>推进选中任务</button>
      </div>
     </details>

     <button type="button" className={"ta-icon-btn "+(detailOpen&&!analysis?"active":"")} aria-label="切换预览侧栏" aria-pressed={detailOpen} title="预览侧栏" onClick={()=>{setAnalysis(null);setDetailOpen(!detailOpen);setMobileDetail(!detailOpen);}}><PanelRight size={15}/></button>
    </div>
   </header>

   {/* Subtle status feedback or active scope chips only when explicitly needed */}
   {notice&&<div className="ta-inline-notice" role="status"><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={()=>setNotice("")}><X size={12}/></button></div>}
   {(scope!=="all"||query)&&<div className="ta-active-scope-bar">
    <span>当前范围</span>
    {scope!=="all"&&<button type="button" onClick={()=>setScope("all")}>清单：{collections.find(c=>c.key===scope)?.name}<X size={11}/></button>}
    {query&&<button type="button" onClick={()=>setQuery("")}>搜索：{query}<X size={11}/></button>}
    <button type="button" className="ta-clear-link" onClick={clearFilters}>重置</button>
   </div>}

   <div className="tw-body">
    <section className="tw-canvas" aria-label={modes.find(m=>m.id===mode)?.name||"列表"}>
     <div className="tw-paper-sheet">
      {!visible.length&&<div className="ta-empty"><p>当前范围内没有符合条件的任务</p><button type="button" onClick={clearFilters}>清除筛选</button></div>}

      {/* Default Today Focus 3-tier Inset Grouped view */}
      {isFocusThreeTier&&visible.length>0&&<div className="tw-focus-sections">
       <section className="tw-inset-group">
        <header className="tw-group-head">
         <span className="tw-group-title"><span className="tw-dot-danger"/>到期与逾期承诺</span>
         <span className="tw-group-count tabular-nums">{dueTodayTasks.length}</span>
        </header>
        {dueTodayTasks.length>0 ? <div className="tw-inset-card">{dueTodayTasks.map(row)}</div> : <p className="tw-inset-empty">当前范围内没有今天到期或逾期的承诺。</p>}
       </section>

       <section className="tw-inset-group">
        <header className="tw-group-head">
         <span className="tw-group-title"><span className="tw-dot-accent"/>今日计划（我的行动池）</span>
         <span className="tw-group-count tabular-nums">{plannedTodayTasks.length} / {TODAY_POOL_LIMIT}</span>
        </header>
        {plannedTodayTasks.length>0 ? <div className="tw-inset-card">{plannedTodayTasks.map(row)}</div> : <div className="tw-inset-empty-action"><span>悬停任意待办点击「今日」加入，或让 AI 协助</span><button type="button" onClick={()=>beginAnalysis('today')}><Sparkles size={12}/>安排今天</button></div>}
       </section>

       {waitingTasks.length>0&&<section className="tw-inset-group">
        <header className="tw-group-head">
         <span className="tw-group-title"><span className="tw-dot-warn"/>等待跟进 / 阻塞项</span>
         <span className="tw-group-count tabular-nums">{waitingTasks.length}</span>
        </header>
        <div className="tw-inset-card">{waitingTasks.map(row)}</div>
       </section>}

       {backlogTasks.length>0&&<details className="tw-backlog-disclosure" open={dueTodayTasks.length===0&&plannedTodayTasks.length===0}>
        <summary><span>其余待办（暂不打扰今日聚焦）</span><span className="tabular-nums">{backlogTasks.length}</span></summary>
        <div className="tw-inset-card">{backlogTasks.map(row)}</div>
       </details>}
      </div>}

      {/* Standard Inset Grouped flat list for Open / Done / Search */}
      {!isFocusThreeTier&&mode==="list"&&visible.length>0&&<div className="tw-inset-group">
       <div className="tw-inset-card">{visible.map(row)}</div>
      </div>}

      {mode==="table"&&visible.length>0&&<table className="ta-table"><thead><tr><th>任务名称</th><th>状态</th><th>项目与清单</th><th>来源</th><th>到期日期</th></tr></thead><tbody>{visible.map(t=><tr key={t.id} className={selected===t.id?"selected":""}><td><button onClick={()=>pick(t)}>{t.title}</button></td><td>{taskStates[t.status]}</td><td>{t.project}</td><td>{t.source}</td><td className="tabular-nums">{t.date||"—"}</td></tr>)}</tbody></table>}
      {mode==="board"&&visible.length>0&&<div className="tw-board">{Object.entries(taskStates).map(([key,label])=><section key={key}><header>{label}<small className="tabular-nums">{visible.filter(t=>t.status===key).length}</small></header>{visible.filter(t=>t.status===key).map(t=><article key={t.id} className={selected===t.id?"selected":""}><button onClick={()=>pick(t)}><strong>{t.title}</strong><p>{t.project}</p><small className="tabular-nums">{t.date||"未安排日期"}</small></button><select aria-label={"状态 "+t.title} value={t.status} onChange={e=>status(t,e.target.value as TaskState)}>{Object.entries(taskStates).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></article>)}{!visible.some(t=>t.status===key)&&<p className="tw-empty-column">暂无任务</p>}</section>)}</div>}
      {mode==="timeline"&&visible.length>0&&<><div className="tw-timeline"><div className="tw-timeline-head"><span>任务</span>{Array.from({length:7},(_,i)=><span key={i} className="tabular-nums">11/{9+i}<small>{"一二三四五六日"[i]}</small></span>)}</div>{visible.filter(t=>t.date).map(t=>{const day=Number(t.date.slice(8))-9;return <div className="tw-timeline-row" key={t.id}><button onClick={()=>pick(t)}>{t.title}</button><div>{t.date>="2026-11-09"&&t.date<="2026-11-15"?<button className={"tw-timeline-bar tw-"+t.status} style={{left:(day/7*100)+"%",width:(100/7)+"%"}} onClick={()=>pick(t)} title={t.title+" · "+t.date}>{taskStates[t.status]}</button>:<button className="tw-outside tabular-nums" onClick={()=>pick(t)}>{t.date} · 本周范围外</button>}</div></div>;})}</div><h3 className="tw-section-heading">未安排 <small className="tabular-nums">{visible.filter(t=>!t.date).length} 项</small></h3><div className="tw-inset-card">{visible.filter(t=>!t.date).map(row)}</div><p className="tw-footnote">点击任务，在右侧设置计划日期。示例以单日计划呈现。</p></>}
      {mode==="tree"&&visible.length>0&&<div className="tw-tree"><div className="tw-tree-root"><GitBranch size={19}/>{scope==="all"?"我的任务":collections.find(c=>c.key===scope)?.name||scope}</div><ul>{visible.filter(t=>!t.parent||!visible.some(p=>p.id===t.parent)).map(t=>branch(t))}</ul></div>}
      {mode==="relations"&&visible.length>0&&<><label className="tw-relation-picker">中心任务<select aria-label="关联图中心任务" value={visible.some(t=>t.id===selected)?selected:""} onChange={e=>{setSelected(e.target.value);setResource("");}}><option value="" disabled>选择任务</option>{visible.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label>{current&&visible.some(t=>t.id===current.id)?<div className="tw-relations"><button className="tw-relation-center" onClick={()=>pick(current)}><Check size={20}/><strong>{current.title}</strong><small>{taskStates[current.status]} · {current.project}</small></button><div className="tw-resource-branches">{related.map(r=>{const n=nodeById[r.resource];return <div className="tw-resource-branch" key={r.resource}><span>{r.relation}</span><button onClick={()=>{setDetailOpen(true);setResource(n.id);setMobileDetail(true);}}><FileText size={17}/><strong>{n.title}</strong><small>{libraries[n.library].provider} · {libraries[n.library].name}</small></button></div>;})}{!related.length&&<p>此任务暂未关联资料。选择“准备线束设计评审”或“核对跨线束接口”查看示例。</p>}</div></div>:<p className="tw-footnote">选择一项任务查看资料关系。</p>}<p className="tw-footnote">关联图展示任务的依据和记录；这些线不表示任务依赖。</p></>}
     </div>
    </section>

    {analysis?<TaskAnalysis key={analysis.id} request={analysis} tasks={tasks} evidence={evidence} memory={analysisMemory} day={today} onDiscuss={onDiscussAnalysis} onClose={()=>{setAnalysis(null);setMobileDetail(false);}} onRefresh={()=>window.dispatchEvent(new Event('hub-dida-task-demo-change'))} onTask={showAnalysisTask} onAdopt={adoptAdvice} onSource={(id,text)=>{if(nodeById[id])return shared.setDescription(id,text);onUpdate(id,{excerpt:text});return true;}}/>:detailOpen&&(
     <aside className={"tw-detail "+(serifReading?"tw-serif-reading":"")} aria-label="任务详情">
      <header>
       <button className="tw-back" onClick={()=>setMobileDetail(false)}><ArrowLeft size={15}/>返回任务</button>
       <span>{document?"关联资料":"任务详情与上下文"}</span>
       <div className="tw-detail-head-actions">
        <button type="button" className={"tw-serif-toggle "+(serifReading?"active":"")} title="切换正文衬线体阅读" onClick={()=>setSerifReading(v=>!v)}><BookOpen size={13}/><span>{serifReading?"衬线":"无衬线"}</span></button>
        {document&&<button type="button" onClick={()=>setResource("")}><X size={14}/>返回任务</button>}
        <button type="button" aria-label="关闭详情" onClick={()=>{setDetailOpen(false);setMobileDetail(false);}}><X size={15}/></button>
       </div>
      </header>
      {document ? <Resource node={document} onLocate={onLocate}/> : current ? (
       <div className="tw-detail-content tw-claude-measure">
        <div className="tw-detail-eyebrow"><span>{current.source} · {current.project}{current.parent?" · 子任务":""}</span><code className="tabular-nums">{current.id}</code></div>
        <h1>{current.title}</h1>

        {/* Primary & quick execution actions */}
        <div className="tw-detail-action-row">
         <button type="button" className="ta-analysis-primary" disabled={current.status==='done'} onClick={()=>beginAnalysis('task',current)}><Sparkles size={13}/>分析并推进</button>
         {current.status!=='done'&&<button type="button" className={"tw-pill-btn "+(isCurrentToday?"active":"")} onClick={()=>handleToggleToday(current.id)}><Target size={13}/>{isCurrentToday?"移出今日计划":"加入今日计划"}</button>}
         {current.status!=='done'&&<button type="button" className={"tw-pill-btn "+(current.status==='waiting'?"warn":"")} onClick={()=>openWaitingEditor(current)}><Clock3 size={13}/>{current.status==='waiting'?"编辑等待条件":"记录等待"}</button>}
        </div>

        {/* Waiting condition card / inline editor */}
        {waitingEditorId===current.id && (
         <div className="tw-waiting-editor">
          <strong>记录等待条件（不丢失原任务）</strong>
          <label>等谁<input value={waitingPerson} onChange={e=>setWaitingPerson(e.target.value)} placeholder="如：供应商接口负责人 / DRE"/></label>
          <label>缺什么条件<input value={waitingReason} onChange={e=>setWaitingReason(e.target.value)} placeholder="如：等待最终图纸版本确认"/></label>
          <label>回看日期（可选）<input type="date" value={waitingReviewDate} onChange={e=>setWaitingReviewDate(e.target.value)}/></label>
          <div className="tw-waiting-editor-actions">
           <button type="button" className="ta-analysis-primary" onClick={()=>commitWaitingCondition(current)}>保存等待状态</button>
           <button type="button" className="tw-pill-btn" onClick={()=>setWaitingEditorId(null)}>取消</button>
          </div>
         </div>
        )}
        {activeWaitInfo&&waitingEditorId!==current.id&&(
         <div className="tw-waiting-banner">
          <div>
           <strong>等待 {activeWaitInfo.person}</strong>
           <p>{activeWaitInfo.reason}{activeWaitInfo.reviewDate?` · 预计 ${activeWaitInfo.reviewDate} 跟进`:""}</p>
          </div>
          <button type="button" className="tw-pill-btn" onClick={()=>clearWaitingCondition(current)}>条件已满足，恢复</button>
         </div>
        )}

        {/* Compact Inset Grouped metadata */}
        <div className="tw-meta-inset">
         <label><span>状态</span><select aria-label="详情任务状态" value={current.status} onChange={e=>status(current,e.target.value as TaskState)}>{Object.entries(taskStates).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
         <label><span>计划日期</span><input type="date" aria-label="详情任务计划日期" value={current.date} onChange={e=>date(current,e.target.value)}/></label>
        </div>

        <p className="ta-task-description">{current.description}</p>
        {items.find(item=>item.id===current.id)?.workId&&onOpenAnalysis&&<button className="tw-origin" onClick={()=>onOpenAnalysis(items.find(item=>item.id===current.id)!)}>查看原分析<ArrowUpRight size={14}/></button>}
        {analysisMemory.notes[current.id]&&<section className="ta-detail-ai-note"><h3>Hub 建议笔记</h3><p>{analysisMemory.notes[current.id]}</p></section>}

        {nodeById[current.id]?.sections?.map((section,index)=>section.type==="h2"?<h3 key={index}>{section.text}</h3>:section.type==="checklist"?<ul className="tw-task-checklist" key={index}>{section.items?.map(text=><li key={text}><input type="checkbox" aria-label={"任务检查项 "+text} checked={shared.checks["check:"+current.id+":"+index+":"+text]??false} onChange={e=>shared.setChecks(old=>({...old,["check:"+current.id+":"+index+":"+text]:e.target.checked}))}/>{text}</li>)}</ul>:section.items?<ul key={index}>{section.items.map(text=><li key={text}>{text}</li>)}</ul>:<p key={index}>{section.text}</p>)}
        {tasks.some(t=>t.parent===current.id)&&<><h3>子任务</h3><div className="tw-inset-card">{tasks.filter(t=>t.parent===current.id).map(row)}</div></>}

        {/* Evidence & Context section */}
        <section className="tw-context-section">
         <h3>关联资料与依据 <small className="tabular-nums">{related.length}</small></h3>
         {related.length>0 ? <div className="tw-inset-card">{related.map(r=>{const n=nodeById[r.resource];return <button className="tw-resource-link" key={r.resource} onClick={()=>setResource(r.resource)}><FileText size={15}/><span><strong>{n.title}</strong><small>{r.relation} · {libraries[n.library].provider} · {n.description||""}</small></span><ArrowUpRight size={13}/></button>;})}</div> : <p className="tw-footnote">此示例暂未关联资料。</p>}
        </section>

        {nodeById[current.id]&&<button className="tw-origin" onClick={()=>onLocate(current.id)}>在来源结构中定位<ArrowUpRight size={14}/></button>}
       </div>
      ) : <p className="tw-footnote">选择任务查看详情。</p>}
     </aside>
    )}
   </div>
  </main>
 </div>;
}

function Resource({node,onLocate}:{node:LibraryNode;onLocate:(id:string)=>void}){return <div className="tw-detail-content tw-claude-measure"><small className="tw-detail-eyebrow">{libraries[node.library].provider} · {pathOf(node)}</small><h1>{node.title}</h1>{contentOf(node).sections?.map((s,i)=>s.type==="h2"?<h3 key={i}>{s.text}</h3>:s.items?<ul key={i}>{s.items.map(t=><li key={t}>{t}</li>)}</ul>:<p key={i}>{s.text}</p>)}{node.rows&&<div className="tw-resource-table"><table><tbody>{node.rows.map((r,i)=><tr key={i}>{r.map((v,j)=><td key={j}>{v}</td>)}</tr>)}</tbody></table></div>}<button className="tw-origin" onClick={()=>onLocate(node.id)}>在资料库中定位<ArrowUpRight size={14}/></button></div>;}
