"use client";
import {useEffect,useRef,useState} from "react";
import {Plus,X,ArrowLeft,Pencil,SearchX} from "lucide-react";
import {JournalViewsContext,useJournalViewStore,journalMonthDays,shiftJournalDay,localJournalDate} from "./journal-local/JournalViews";
import {JournalToolbar} from "./journal-local/JournalToolbar";
import {journalDateInRange,journalMatchesQuery,journalUsesResultDays,journalStreamDates} from "./journal-filter";
import {JournalNavigation} from "./journal-local/JournalNavigation";
import {useDidaTasks} from "./useDidaTasks";
import {didaTasks,taskDate,taskStatus,taskProject} from "./task-data";
import QuickMemo,{QuickMemoComposer} from "./QuickMemo";
import {sampleMemos,journalRecordMatches,journalRecordFilters,type JournalRecordFilter,type MemoRecord,type MemoScope} from "./memo-data";
import {journalActivity,journalHeatLevel} from "./layout-data";
import {splitJournalCapture,type JournalCaptureTask} from "./journal-capture";
import type {HubItem} from "./data";
const KEY="hub-journal-prototype-records-v1";
type RecordEntry=MemoRecord;
type CaptureDraft={text:string;files:string[]};
type DailyEditor={day:string;id?:string};
const blankDraft:CaptureDraft={text:"",files:[]};
const noteKey=(day:string,id?:string)=>id?"edit:"+id:"day:"+day;
const hasDraftContent=(draft:CaptureDraft)=>!!(draft.text||draft.files.length);
const draftKey=(editor:DailyEditor)=>noteKey(editor.day,editor.id);
const editorTitle=(editor:DailyEditor)=>editor.id?"编辑日志":"新建日志";
function draftEditor(key:string,records:RecordEntry[]):DailyEditor|null{
 const day=key.slice(key.indexOf(":")+1);
 if(key.startsWith("edit:")){
  const record=records.find(r=>r.id===day);
  return record?{day:record.date,id:record.id}:null;
 }
 if(!shiftJournalDay(day,0))return null;
 if(key.startsWith("day:"))return {day};
 return null;
}

export default function JournalSite({onOpenSettings,onOpenCloud,items,onTaskOpen,onCreateTasks,onUpdateTask,navigationOpen,onToggleNavigation,navigationResizer}:{onOpenSettings?:()=>void;onOpenCloud?:()=>void;items:HubItem[];onTaskOpen:(id:string)=>void;onCreateTasks:(tasks:JournalCaptureTask[],day:string)=>void;onUpdateTask:(id:string,change:Partial<HubItem>)=>void;navigationOpen:boolean;navigationResizer?:React.ReactNode;onToggleNavigation:()=>void}){
 const today=localJournalDate();
 const [editingMemo,setEditingMemo]=useState(""),[editor,setEditor]=useState<DailyEditor|null>(null);
 const [dailyDrafts,setDailyDrafts]=useState<Record<string,CaptureDraft>>({}),[minimized,setMinimized]=useState<DailyEditor|null>(null);
 const editorTrigger=useRef<HTMLElement|null>(null),editorPanel=useRef<HTMLElement>(null),draftDock=useRef<HTMLDivElement>(null);
 const store=useJournalViewStore(),{view}=store,shared=useDidaTasks();
 const [ready,setReady]=useState(false),[records,setRecords]=useState<RecordEntry[]>([]),[text,setText]=useState(""),[date,setDate]=useState(today),[files,setFiles]=useState<string[]>([]),[selected,setSelected]=useState<RecordEntry|null>(null),[mobileDetail,setMobileDetail]=useState(false),[days,setDays]=useState(7),[completedDate,setCompletedDate]=useState(""),[notice,setNotice]=useState(""),[chosenDay,setChosenDay]=useState("");
 const dialog=useRef<HTMLDialogElement>(null),completedTrigger=useRef<HTMLButtonElement|null>(null);
 useEffect(()=>{
  try{
   const value=JSON.parse(localStorage.getItem(KEY)||"null");
   setRecords(Array.isArray(value?.records)?value.records:sampleMemos);
   const drafts=value?.dailyDrafts;
   if(drafts&&typeof drafts==="object"){
    const merged:Record<string,CaptureDraft>={...drafts};
    for(const [key,task] of Object.entries(merged)){
     if(!key.startsWith("task:"))continue;
     const day=shiftJournalDay(key.slice(5),0);
     if(day&&task.text.trim()){
      const id=noteKey(day),note=merged[id]||blankDraft;
      merged[id]={...note,text:"- [ ] "+task.text.trim()+(note.text?"\n\n"+note.text:"")};
     }
     delete merged[key];
    }
    setDailyDrafts(merged);
   }
   const draft=value?.draft;
   if(draft){
    const note:CaptureDraft={text:typeof draft.text==="string"?draft.text:"",files:Array.isArray(draft.files)?draft.files:[]};
    const day=shiftJournalDay(draft.date,0)||today;
    const requestedLayout=new URLSearchParams(window.location.search).get("layout");
    if(!drafts&&(requestedLayout||view.layout)==="stream"&&(hasDraftContent(note)||draft.editingId)){
     setDailyDrafts({[noteKey(day,draft.editingId)]:note});
    }else{
     setText(note.text);setFiles(note.files);setDate(day);setEditingMemo(draft.editingId||"");
    }
   }
  }catch{setRecords(sampleMemos);}
  setReady(true);
 },[]);
 useEffect(()=>{if(ready)try{localStorage.setItem(KEY,JSON.stringify({...JSON.parse(localStorage.getItem(KEY)||"{}"),records,draft:{text,date,files,editingId:editingMemo},dailyDrafts}));}catch{}},[ready,records,text,date,files,editingMemo,dailyDrafts]);
 useEffect(()=>{if(completedDate)dialog.current?.showModal();},[completedDate]);
 useEffect(()=>{const layout=new URLSearchParams(window.location.search).get("layout");if(layout==="records")store.update({layout:"records",period:"all",libraries:null});else if(layout==="stream")store.update({layout:"stream"});else if(layout==="calendar")store.update({layout:"calendar",period:"month"});},[]);
 const memoScope:MemoScope=view.recordFilter==="pinned"?{kind:"pinned"}:{kind:"all"};
 const entries:RecordEntry[]=[...records,...items.filter(i=>i.kind==="journal").map(i=>({id:i.id,date:i.date,tags:i.tags,text:i.sections.map(s=>s.text||s.items?.join("\n")).join("\n\n"),files:[],library:i.source==="obsidian"?"OS":i.source==="craft"?"Car":"Hub"}))];
 const activity=journalActivity(entries);
 const scopedEntries=entries.filter(e=>journalDateInRange(e.date,view)&&journalMatchesQuery(e,view.query)&&(view.libraries===null||view.libraries.includes(e.library||"OS")));
 const filtered=scopedEntries.filter(e=>journalRecordMatches(e,view.recordFilter)).sort((a,b)=>view.ascending?a.date.localeCompare(b.date):b.date.localeCompare(a.date));
 const counts=new Map(journalActivity(filtered).map(day=>[day.date,day.count]));
 const calendarMonths=new Map<string,number>();
 for(const entry of filtered){const month=entry.date.slice(0,7);calendarMonths.set(month,(calendarMonths.get(month)||0)+1);}
 const filterCounts=Object.fromEntries(Object.keys(journalRecordFilters).map(key=>[key,scopedEntries.filter(e=>journalRecordMatches(e,key as JournalRecordFilter)).length])) as Record<JournalRecordFilter,number>;
 const applyRecordFilter=(recordFilter:JournalRecordFilter)=>{store.update({recordFilter});setSelected(null);setMobileDetail(false);};
 const selectQuickFilter=(recordFilter:JournalRecordFilter)=>{applyRecordFilter(view.recordFilter===recordFilter?"all":recordFilter);if(window.innerWidth<1100&&navigationOpen)onToggleNavigation();};
 const pick=(e:RecordEntry)=>{setSelected(e);setMobileDetail(true);if(window.innerWidth<1100&&navigationOpen)onToggleNavigation();};
 const openEditor=(next:DailyEditor,trigger:HTMLElement|null)=>{
  editorTrigger.current=trigger;setEditor(next);setMobileDetail(false);setSelected(null);
 };
 function minimizeEditor(focusCapsule=false){
  if(!editor)return;
  setMinimized(editor);setEditor(null);
  if(focusCapsule)requestAnimationFrame(()=>draftDock.current?.querySelector("button")?.focus({preventScroll:true}));
 }
 useEffect(()=>{
  if(!editor)return;
  const onOutside=(e:PointerEvent)=>{
   if(e.target instanceof Node&&!editorPanel.current?.contains(e.target)){setMinimized(editor);setEditor(null);}
  };
  document.addEventListener("pointerdown",onOutside,true);
  return()=>document.removeEventListener("pointerdown",onOutside,true);
 },[editor]);
 const write=(day:string,trigger:HTMLElement|null,record?:RecordEntry)=>{
  if(!shiftJournalDay(day,0))return;
  if(record)setDailyDrafts(old=>Object.hasOwn(old,noteKey(day,record.id))?old:{...old,[noteKey(day,record.id)]:{text:record.text,files:record.files}});
  openEditor({day,id:record?.id},trigger);
 };
 const navigate=(day:string)=>{const target=day.length===7?day+"-01":day||today;if(!shiftJournalDay(target,0))return;store.navigate(target);if(!text.trim()&&!files.length&&!editingMemo)setDate(target);setDays(7);if(window.innerWidth<1100&&navigationOpen)onToggleNavigation();};
 const tasks=[
  ...didaTasks.map(n=>({id:n.id,title:n.title,description:n.description,project:taskProject(n.id),library:"dida",sharedDemo:true,date:taskDate(n.id,shared.dates),completed:taskStatus(n.id,shared.checks,shared.status)==="done",completedOn:shared.completed[n.id]})),
  ...items.filter(n=>n.kind==="task"&&n.due&&(n.source==="hub"||n.source==="ticktick"&&n.id.startsWith("journal-task-"))).map(n=>({id:n.id,title:n.title,description:n.excerpt,project:n.source==="ticktick"?"滴答清单 · "+(n.project||"收件箱"):n.project||"个人",library:n.source==="ticktick"?"dida":"Hub",sharedDemo:false,date:n.due||"",completed:n.taskState==="done",completedOn:n.completedOn||n.due}))
 ].filter(t=>view.recordFilter==="all"&&(view.libraries===null||view.libraries.includes(t.library))&&[t.title,t.description].join(" ").toLowerCase().includes(view.query.trim().toLowerCase()));
 const scopedTasks=tasks.filter(t=>journalDateInRange((t.completed?t.completedOn:undefined)||t.date,view));
 const dailyTasks=(day:string)=>scopedTasks.filter(t=>t.date===day),completed=(day:string)=>scopedTasks.filter(t=>t.completed&&(t.completedOn||t.date)===day);
 const taskRow=(t:typeof tasks[number])=><div className={"journal-daily-task "+(t.completed?"is-completed":"")} key={t.id}><input type="checkbox" aria-label={"日志中完成任务 "+t.title} checked={t.completed} onChange={()=>t.sharedDemo?shared.setStatus(t.id,t.completed?"todo":"done"):onUpdateTask(t.id,{taskState:t.completed?"todo":"done"})}/><button onClick={()=>onTaskOpen(t.id)}><span className="task-title">{t.title}</span><span className="task-library">{t.project}</span></button></div>;
 const entryCard=(e:RecordEntry)=><article className="quick-journal-card" key={e.id}><header><span>{e.date}</span><span>{records.some(r=>r.id===e.id)?(e.library==="OS"?"Obsidian · OS":"已保存到此浏览器"):"来源日志 · 示例"}</span></header><button className="js-record-open" aria-label={"预览日志 "+e.date} onClick={()=>pick(e)}><p>{e.text.slice(0,350)}</p></button>{e.files.length>0&&<p>{e.files.join(" · ")} · 附件名称示例</p>}</article>;
 const dayTitle=(day:string)=>`${Number(day.slice(5,7))}月${Number(day.slice(8))}日`;
 const anchor=view.period==="day"?view.day:store.anchor&&store.anchor.startsWith(view.month+"-")?store.anchor:(view.month===today.slice(0,7)?today:view.month+"-01");
 const resultDays=journalUsesResultDays(view);
 const streamDates=journalStreamDates(view,anchor,days,[...filtered.map(e=>e.date),...scopedTasks.map(t=>(t.completed?t.completedOn:undefined)||t.date)]);
 const canShowLater=!resultDays&&view.period!=="day"&&days<35&&journalDateInRange(shiftJournalDay(anchor,days),view);
 useEffect(()=>{setDays(7);setSelected(null);setMobileDetail(false);setChosenDay("");},[store.activeId,view.layout,view.period,view.month,view.day,view.query,view.recordFilter,JSON.stringify(view.libraries)]);
 function closeCompleted(){dialog.current?.close();setCompletedDate("");completedTrigger.current?.focus();}
 function changeMemoScope(scope:MemoScope){store.update({recordFilter:scope.kind==="pinned"?"pinned":"all",query:scope.kind==="tag"?"#"+scope.value:"",period:scope.kind==="day"?"day":"all",day:scope.kind==="day"?scope.value||"":"",libraries:null});setSelected(null);setMobileDetail(false);if(window.innerWidth<1100&&navigationOpen)onToggleNavigation();}
 function saveRecord(day:string,draft:CaptureDraft,id?:string){
  const entry={id:id||crypto.randomUUID(),date:day,text:draft.text,files:draft.files};
  setRecords(old=>id?old.map(r=>r.id===id?{...r,...entry}:r):[{...entry,library:"OS"},...old]);
 }
 function saveMemo(recordDate:string){
  if((!text.trim()&&!files.length)||!recordDate)return;
  saveRecord(recordDate,{text,files},editingMemo||undefined);
  setDate(recordDate);setEditingMemo("");setText("");setFiles([]);
  store.update({period:"all",libraries:null,query:"",recordFilter:"all"});
  setNotice("已保存在此浏览器，OS 与云同步尚未连接。");
 }
 const activeDraftKey=editor?draftKey(editor):"";
 const activeDraft=dailyDrafts[activeDraftKey]||blankDraft;
 const minimizedKey=minimized?draftKey(minimized):"";
 const dockDrafts=minimized?[minimized]:[];
 for(const [key,draft] of Object.entries(dailyDrafts)){
  if(key===minimizedKey||(!hasDraftContent(draft)&&!key.startsWith("edit:")))continue;
  const saved=draftEditor(key,records);
  if(saved)dockDrafts.push(saved);
 }
 function updateDraft(patch:Partial<CaptureDraft>){setDailyDrafts(old=>({...old,[activeDraftKey]:{...old[activeDraftKey]||blankDraft,...patch}}));}
 function finishCreation(){
  setDailyDrafts(old=>{const next={...old};delete next[activeDraftKey];return next;});
  if(minimizedKey===activeDraftKey)setMinimized(null);
  setEditor(null);
  const trigger=editorTrigger.current,day=editor?.day;
  requestAnimationFrame(()=>{
   const next=trigger?.isConnected?trigger:draftDock.current?.querySelector("button")||(day?document.querySelector<HTMLButtonElement>(`[data-journal-day="${day}"] .journal-daily-actions button`):null);
   next?.focus({preventScroll:true});
  });
 }
 const capture=splitJournalCapture(activeDraft.text);
 const hasJournal=!!(capture.text.trim()||activeDraft.files.length);
 const canCreate=hasJournal||capture.tasks.length>0;
 function saveCapture(){
  if(!editor||!canCreate)return;
  if(hasJournal)saveRecord(editor.day,{...activeDraft,text:capture.text},editor.id);
  if(capture.tasks.length)onCreateTasks(capture.tasks,editor.day);
  const destinations=[hasJournal?"日志 → Obsidian":null,capture.tasks.length?capture.tasks.length+" 条任务 → 滴答清单":null].filter(Boolean).join("；");
  setNotice(dayTitle(editor.day)+"："+destinations+"（原型演示）"+(editor.id&&!hasJournal?"。原日志未修改":"")+(view.query||view.recordFilter!=="all"||view.libraries!==null?"。若未显示，可检查当前筛选。":"。"));
  finishCreation();
 }
 const renderMemo=(rows:RecordEntry[],embedded=false,showComposer=true)=><QuickMemo records={rows} hideToolbar embedded={embedded} showComposer={showComposer} summary={view.summary} showSource={view.source} allRecords={records} scope={embedded?{kind:"all"}:memoScope} onScope={scope=>{if(embedded&&scope.kind==="tag"){store.update({query:"#"+scope.value});}else changeMemoScope(scope);}} query={embedded?"":view.query} onQuery={query=>store.update({query})} text={text} onText={setText} date={date} onDate={setDate} files={files} onFiles={setFiles} editingId={editingMemo} onEdit={id=>{setEditingMemo(id);setSelected(null);setMobileDetail(false);}} onEditRecord={embedded?(record,trigger)=>write(record.date,trigger,record):undefined} onSave={saveMemo} onCancel={()=>{setEditingMemo("");setText("");setFiles([]);}} onPin={id=>setRecords(old=>old.map(r=>r.id===id?{...r,pinned:!r.pinned}:r))} onExamples={()=>setRecords(old=>[...old,...sampleMemos.filter(r=>!old.some(e=>e.id===r.id))])} onPreview={pick} periodLabel={[view.period==="month"?view.month:view.period==="day"?view.day:"",view.libraries?.length?"资料库："+view.libraries.join("、"):""].filter(Boolean).join(" · ")} onClearRange={()=>store.update({period:"all",libraries:null,recordFilter:"all"})} settings={<details className="memo-storage-settings"><summary>保存位置与同步设置</summary><p>记录仅保存在当前浏览器。保存位置与云同步分别管理。</p><button onClick={onOpenSettings}>配置速记保存位置</button><button onClick={onOpenCloud}>查看云同步状态</button></details>}/>;
 if(!ready)return <div className="js-loading">正在准备日志视图…</div>;
 return <JournalViewsContext.Provider value={store}><div className={"journal-site "+"js-memo-integrated "+(navigationOpen?"js-nav-open ":"")+(mobileDetail?"js-mobile-detail":"")}>
  <aside id="hub-module-navigation" className="js-navigation"><header><h1>日志</h1><button className="tw-mobile-close" aria-label="关闭日志导航" onClick={onToggleNavigation}><X size={16}/></button></header><JournalNavigation dates={activity} selectedDate={anchor} onSelectDate={navigate} filterCounts={filterCounts} onFilter={selectQuickFilter}/><p className="js-demo-note">日志交互 · 示例数据<br/>先在这里确认交互，再修改桌面端</p></aside>{navigationResizer}{navigationOpen&&<button className="tw-scrim" aria-label="关闭日志导航遮罩" onClick={onToggleNavigation}/>}
  <main className={"journal-database results-pane "+(view.layout==="stream"?"is-daily ":"")+(view.compact?"is-compact ":"")+(view.layout==="records"?"is-memo":"")}>
   <JournalToolbar store={store} resultCount={filtered.length} taskCount={view.layout==="stream"?scopedTasks.length:undefined} onUpdate={store.update} onCreate={view.layout==="list"||view.layout==="calendar"?trigger=>write(anchor,trigger):undefined}/>
   {notice&&<div className="js-notice" role="status">{notice}<button aria-label="关闭日志提示" onClick={()=>setNotice("")}><X size={13}/></button></div>}

   <div className="journal-db-body">
    {view.layout==="stream"&&<div className="journal-daily-stream">
     {!resultDays&&view.period!=="day"&&<button className="journal-daily-previous" onClick={()=>navigate(shiftJournalDay(anchor,-7))}>↑ 显示前几天</button>}
     {resultDays&&!streamDates.length&&<div className="journal-search-empty" role="status"><SearchX size={26}/><h2>没有符合条件的记录</h2><p>试试其他关键词，或扩大日期和资料库范围。</p><button onClick={()=>store.update({query:"",period:"all",day:"",libraries:null,recordFilter:"all"})}>查看全部记录</button></div>}
     {streamDates.map(day=>{
      const rows=filtered.filter(e=>e.date===day),relative=day===today?"今天":day===shiftJournalDay(today,1)?"明天":day===shiftJournalDay(today,-1)?"昨天":"";
      const dayCompleted=completed(day);
      return <section data-journal-day={day} className={"journal-daily-day "+(day===today?"is-today":"")} key={day} aria-label={dayTitle(day)}>
       <button className="journal-daily-date" onClick={()=>store.navigate(day)}>
        <span className="date-title">{dayTitle(day)}</span>{relative&&<span className="relative-day">{relative}</span>}<span className="weekday">星期{"日一二三四五六"[new Date(day+"T12:00:00").getDay()]}</span>
       </button>
       <div className="journal-daily-content">
        {rows.length>0&&renderMemo(rows,true,false)}
        <div className="journal-daily-tasks">
         {dailyTasks(day).filter(t=>!t.completed).map(taskRow)}
         {day==="2026-11-08"&&tasks.some(t=>t.id==="d-review"&&t.date!==day)&&<details className="journal-daily-created" open><summary><b>1</b>当天新建</summary>{taskRow(tasks.find(t=>t.id==="d-review")!)}</details>}
         {dayCompleted.length>0&&<button className="journal-daily-completed-trigger" onClick={e=>{completedTrigger.current=e.currentTarget;setCompletedDate(day);}}><b>{dayCompleted.length}</b>已完成的任务</button>}
        </div>
        <div className="journal-daily-actions"><button type="button" aria-label={dayTitle(day)+" 新建"} onClick={e=>write(day,e.currentTarget)}><Plus size={15}/>新建</button></div>
       </div>
      </section>;
     })}
     {canShowLater&&<button className="journal-daily-next" onClick={()=>setDays(n=>n+7)}>↓ 显示后几天</button>}
    </div>}
    {view.layout==="records"&&renderMemo(filtered)}
    {view.layout==="calendar"&&<div className="journal-db-calendar">{view.period==="all"&&[...calendarMonths.keys()].some(month=>month!==view.month)&&<nav className="journal-result-months" aria-label="有匹配日志的月份"><span>匹配月份</span>{[...calendarMonths].map(([month,count])=><button type="button" key={month} aria-pressed={month===view.month} onClick={()=>store.update({month})}>{month.slice(0,4)}年{Number(month.slice(5))}月 <small>{count} 条</small></button>)}</nav>}<div className="journal-month-week">{"日一二三四五六".split("").map(d=><span key={d}>{d}</span>)}</div><div className="journal-month-grid">{journalMonthDays(view.month,true).map(day=><section data-heat={journalHeatLevel(counts.get(day)||0)} title={day+" · "+(counts.get(day)||0)+" 条匹配日志（不含任务）"} className={"journal-month-cell "+(day===chosenDay?"selected ":"")+(day.slice(0,7)!==view.month?"outside-month":"")} key={day}><button className="journal-month-date" onClick={()=>setChosenDay(day)}>{Number(day.slice(8))}</button>{!!counts.get(day)&&<span className="journal-month-count">{counts.get(day)} 条</span>}{filtered.filter(e=>e.date===day).map(e=><button className="journal-month-entry" key={e.id} onClick={()=>pick(e)}><span>{e.text.slice(0,30)||"附件记录"}</span></button>)}</section>)}</div>{chosenDay&&<section className="journal-day-agenda"><header><strong>{chosenDay}</strong><button aria-label="关闭当天日志" onClick={()=>setChosenDay("")}><X size={16}/></button></header>{filtered.filter(e=>e.date===chosenDay).map(entryCard)}<button onClick={e=>write(chosenDay,e.currentTarget)}><Plus size={14}/>写这一天</button><button onClick={()=>{store.update({period:"day",day:chosenDay,layout:"list"});}}>仅看这一天</button></section>}</div>}
    {view.layout==="list"&&<div className="journal-db-list">{[...new Set(filtered.map(e=>e.date))].map(day=><section className="journal-list-day" key={day}><header>{dayTitle(day)}</header>{filtered.filter(e=>e.date===day).map(e=><div className="journal-list-row" key={e.id}><button onClick={()=>pick(e)}><span><strong>{e.text.slice(0,35)||"附件记录"}</strong>{view.summary&&<small>{e.text.slice(35,160)}</small>}</span>{view.source&&<em>{records.some(r=>r.id===e.id)?"OS":"来源示例"}</em>}</button></div>)}</section>)}</div>}
    {!filtered.length&&!["records","stream","calendar"].includes(view.layout)&&<p className="js-empty">当前范围暂无日志，可以调整日期或资料库。</p>}
   </div>
   {!editor&&dockDrafts.length>0&&<div className="journal-draft-dock" role="group" aria-label="收起的编辑器" ref={draftDock}>
    {dockDrafts.map(draft=>{
     const hasDraft=hasDraftContent(dailyDrafts[draftKey(draft)]||blankDraft);
     const label=hasDraft?(draft.id?"日志修改":"草稿"):editorTitle(draft);
     return <button key={draftKey(draft)} type="button" title={label+" · "+draft.day} onClick={e=>openEditor(draft,e.currentTarget)}><Pencil size={14}/><span>{dayTitle(draft.day)} · {label}</span></button>;
    })}
   </div>}
   {editor&&<section key={activeDraftKey} ref={editorPanel} className="journal-floating-editor" role="dialog" aria-modal="false" aria-labelledby="journal-editor-title"
    onBlur={e=>{if(e.relatedTarget instanceof Node&&!e.currentTarget.contains(e.relatedTarget))minimizeEditor();}}
    onKeyDown={e=>{if(e.key==="Escape"&&!e.nativeEvent.isComposing){e.preventDefault();e.stopPropagation();minimizeEditor(true);}}}>
    <header><div><h2 id="journal-editor-title">{editorTitle(editor)}</h2><time dateTime={editor.day}>{editor.day.slice(0,4)}年{dayTitle(editor.day)}</time></div><button type="button" aria-label="收起编辑器" onClick={()=>minimizeEditor(true)}><X size={17}/></button></header>
    <QuickMemoComposer autoFocus allowTasks canSubmit={canCreate} date={editor.day} text={activeDraft.text} files={activeDraft.files} editingId={editor.id||""} onText={text=>updateDraft({text})} onFiles={files=>updateDraft({files})} onSave={saveCapture} submitLabel={editor.id?"保存修改":"创建"}/>
    <p className="journal-capture-destinations"><span>正文 → Obsidian</span><span>待办行 → 滴答清单{capture.tasks.length>0?" · "+capture.tasks.length+" 条":""}</span><small>原型演示</small></p>
    <p className="journal-editor-hint">离开后可从右侧继续 · Ctrl / ⌘ + Enter {editor.id?"保存":"创建"}</p>
   </section>}
  </main>
  {selected&&<aside className="js-reader"><header><button onClick={()=>{setSelected(null);setMobileDetail(false);}}><ArrowLeft size={15}/>返回日志</button><span>{selected.date}</span></header><article><h1>{dayTitle(selected.date)} · 日志</h1><p>{selected.text}</p>{selected.files.length>0&&<p>{selected.files.join(" · ")}</p>}</article></aside>}
  <dialog ref={dialog} className="journal-completed-dialog" onCancel={e=>{e.preventDefault();closeCompleted();}}><header><h2>日志 · 已完成的任务</h2><button aria-label="关闭已完成任务" onClick={closeCompleted}><X size={15}/></button></header><div className="journal-completed-list">{completed(completedDate).map(taskRow)}</div></dialog>
 </div></JournalViewsContext.Provider>;
}
