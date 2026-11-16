import {useContext,useEffect,useId,useRef,useState,type ReactNode} from "react";
import {CalendarDays,Check,ChevronDown,Layers,ListFilter,Plus,RotateCcw,Search,SlidersHorizontal,X} from "lucide-react";
import {journalRecordFilters,type JournalRecordFilter} from "./JournalRecords";
import {JournalViewManager} from "./JournalViewManager";
import {journalLayouts,localJournalDate,type JournalViewConfig,type JournalViewStore} from "./JournalViews";

import {WorkspaceHeaderContext} from "./WorkspaceChrome";
import type {LibrarySummary} from "./SearchTypes";
import "./JournalToolbar.css";

type Props={
  libraries:LibrarySummary[];
  loading?:boolean;
  error?:boolean;
  store:JournalViewStore;
  resultCount:number;
  taskCount?:number;
  onUpdate:(patch:Partial<JournalViewConfig>)=>void;
  onCreate?:(trigger:HTMLButtonElement)=>void;
};
const monthLabel=(month:string)=>`${month.slice(0,4)}年${Number(month.slice(5,7))}月`;
const dateLabel=(day:string)=>`${day.slice(0,4)}年${Number(day.slice(5,7))}月${Number(day.slice(8,10))}日`;

export function JournalToolbar({store,libraries,resultCount,taskCount=0,loading=false,error=false,onUpdate,onCreate}:Props){
  const libraryName=(id:string)=>{const library=libraries.find(value=>value.id===id);return library?`${library.name} · ${{craft:"Craft",obsidian:"Obsidian",dida365:"滴答清单"}[library.provider as "craft"]||library.provider}`:"未连接资料库";};
  const {view}=store;
  const shell=useContext(WorkspaceHeaderContext);
  const uid=useId(),filterId=`journal-filters-${uid}`,saveId=`journal-save-view-${uid}`;
  const filterPanel=useRef<HTMLDivElement>(null),filterButton=useRef<HTMLButtonElement>(null),searchInput=useRef<HTMLInputElement>(null);
  const filterReturn=useRef<HTMLElement|null>(null),filterFocus=useRef("period");
  const saveDialog=useRef<HTMLDialogElement>(null),saveInput=useRef<HTMLInputElement>(null),saveReturn=useRef<HTMLElement|null>(null);
  const [filtersOpen,setFiltersOpen]=useState(false),[saveName,setSaveName]=useState(""),[saveError,setSaveError]=useState("");
  const filterCount=Number(view.period!=="all")+Number(view.libraries!==null)+Number((view.recordFilter||"all")!=="all");
  useEffect(()=>{const shortcut=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"&&!document.querySelector("dialog[open]")){event.preventDefault();event.stopImmediatePropagation();searchInput.current?.focus();}};window.addEventListener("keydown",shortcut,true);return()=>window.removeEventListener("keydown",shortcut,true);},[]);
  const currentMonth=localJournalDate().slice(0,7);
  const defaultDay=store.anchor.startsWith(view.month+"-")?store.anchor:view.month===currentMonth?localJournalDate():view.month+"-01";
  const periodLabel=view.period==="day"?dateLabel(view.day):view.month===currentMonth?`${Number(view.month.slice(5))}月 · 本月`:monthLabel(view.month);
  const sourceLabel=view.libraries===null?"全部资料库":view.libraries.length===0?"未选择资料库":view.libraries.length===1?libraryName(view.libraries[0]):`${view.libraries.length} 个资料库`;
  const clearFilters=()=>onUpdate({period:"all",day:"",libraries:null,recordFilter:"all"});

  function positionFilters(){
    const panel=filterPanel.current,trigger=filterReturn.current||filterButton.current;
    if(!panel||!trigger)return;
    const rect=trigger.getBoundingClientRect(),width=Math.min(360,window.innerWidth-24);
    panel.style.width=`${width}px`;
    panel.style.left=`${Math.max(12,Math.min(rect.right-width,window.innerWidth-width-12))}px`;
    panel.style.top=`${Math.max(12,Math.min(rect.bottom+8,window.innerHeight-panel.offsetHeight-12))}px`;
  }
  function openFilters(trigger:HTMLElement,section="period"){
    filterReturn.current=trigger;filterFocus.current=section;
    if(filterPanel.current?.matches(":popover-open")){
      filterPanel.current.hidePopover();
      return;
    }
    filterPanel.current?.showPopover();
  }
  function closeFilters(){
    filterPanel.current?.hidePopover();
    requestAnimationFrame(()=>filterReturn.current?.isConnected?filterReturn.current.focus({preventScroll:true}):filterButton.current?.focus({preventScroll:true}));
  }
  useEffect(()=>{
    const reposition=()=>{if(filterPanel.current?.matches(":popover-open"))positionFilters();};
    window.addEventListener("resize",reposition);
    window.addEventListener("scroll",reposition,true);
    return()=>{window.removeEventListener("resize",reposition);window.removeEventListener("scroll",reposition,true);};
  },[]);
  useEffect(()=>{if(filtersOpen)positionFilters();},[filtersOpen,view.period]);

  function startSave(){
    saveReturn.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const base=journalLayouts[view.layout];
    let name:string=base,index=2;
    while(store.saved.some(saved=>saved.name===name))name=`${base} ${index++}`;
    setSaveName(name);setSaveError("");
    saveDialog.current?.showModal();
    requestAnimationFrame(()=>{saveInput.current?.focus();saveInput.current?.select();});
  }
  function closeSave(){
    saveDialog.current?.close();
    requestAnimationFrame(()=>saveReturn.current?.isConnected?saveReturn.current.focus({preventScroll:true}):filterButton.current?.focus({preventScroll:true}));
  }
  function toggleLibrary(id:string){
    const selected=view.libraries||[];
    onUpdate({libraries:selected.includes(id)?selected.filter(item=>item!==id):[...selected,id]});
  }
  function chip(label:string,icon:ReactNode,section:string,onClear:()=>void,title=label){
    return <div className="journal-filter-chip" title={title}>
      <button type="button" onClick={event=>openFilters(event.currentTarget,section)} aria-haspopup="dialog" aria-controls={filterId} aria-label={`修改筛选：${title}`}>{icon}<span>{label}</span><ChevronDown size={12}/></button>
      <button type="button" className="journal-chip-clear" aria-label={`清除筛选：${title}`} onClick={onClear}><X size={12}/></button>
    </div>;
  }
  return <section className="journal-toolbar-shell" aria-label="日志视图与筛选工具栏">
    <div className="journal-toolbar-top" onMouseDown={shell?.onMouseDown}>
      <JournalViewManager store={store} onNew={startSave}/>
      <div className="journal-toolbar-actions">{shell?.actions}
        {store.modified&&<div className="journal-view-save-state" aria-label="当前视图有未保存的更改">
          <span className="journal-view-modified-dot" title="当前视图有未保存的更改"/>
          <button type="button" className="journal-view-update" onClick={store.updateSaved} title="将当前筛选与显示设置更新到此视图">更新</button>
          <button type="button" onClick={()=>store.select(store.activeId)} title="恢复此视图已保存的设置">恢复</button>
        </div>}
        <button ref={filterButton} type="button" className={`journal-filter-trigger ${filterCount?"has-filters":""}`} aria-label={`筛选日志${filterCount?`，${filterCount}项条件`:""}`} aria-haspopup="dialog" aria-controls={filterId} aria-expanded={filtersOpen} onClick={event=>openFilters(event.currentTarget)}>
          <SlidersHorizontal size={16}/><span>筛选</span>{filterCount>0&&<span className="journal-filter-count">{filterCount}</span>}
        </button>
        {onCreate&&<button type="button" className="journal-toolbar-create" onClick={event=>onCreate(event.currentTarget)} aria-label="写日志"><Plus size={15}/><span>写日志</span></button>}
      </div>
    </div>
    <div className="journal-toolbar-bottom">
      <label className="journal-toolbar-search">
        <Search size={16}/><span className="journal-toolbar-sr-only">搜索日志内容</span>
        <input ref={searchInput} type="search" aria-label="搜索日志内容" placeholder="搜索日志…" value={view.query} onChange={event=>onUpdate({query:event.target.value})}/>
        {view.query&&<button type="button" aria-label="清空日志搜索" onClick={()=>{onUpdate({query:""});searchInput.current?.focus();}}><X size={14}/></button>}
      </label>
      <div className="journal-toolbar-conditions" aria-label="已生效的日志筛选">
        {view.period!=="all"&&chip(periodLabel,<CalendarDays size={13}/>,"period",()=>onUpdate({period:"all",day:""}))}
        {view.libraries!==null&&chip(sourceLabel,<Layers size={13}/>,"libraries",()=>onUpdate({libraries:null}),view.libraries.length?view.libraries.map(libraryName).join("、"):"未选择资料库")}
        {(view.recordFilter||"all")!=="all"&&chip(journalRecordFilters[view.recordFilter||"all"],<ListFilter size={13}/>,"record",()=>onUpdate({recordFilter:"all"}))}
        {filterCount>0?<button type="button" className="journal-clear-filters" onClick={clearFilters} title="清除日期、资料库与内容类型筛选，保留搜索词">清除筛选</button>:<button type="button" className="journal-add-filter" aria-haspopup="dialog" aria-controls={filterId} onClick={event=>openFilters(event.currentTarget)}><Plus size={13}/><span>添加筛选</span></button>}
      </div>
      <p className="journal-toolbar-results" role="status" aria-live="polite" aria-atomic="true"><span>{error?"结果读取失败":loading?"正在读取…":<><strong>{resultCount}</strong> 条日志</>}</span>{taskCount>0&&<span className="journal-toolbar-task-count"> · {taskCount} 项任务</span>}</p>
    </div>

    <div ref={filterPanel} id={filterId} className="journal-filter-popover" data-hub-keyboard-scope="journal-filter" data-keyboard-open={filtersOpen} popover="auto" role="dialog" aria-label="筛选日志" onToggle={event=>{
      const shown=event.currentTarget.matches(":popover-open");setFiltersOpen(shown);
      if(shown){positionFilters();requestAnimationFrame(()=>filterPanel.current?.querySelector<HTMLElement>(`[data-filter-focus="${filterFocus.current}"]`)?.focus({preventScroll:true}));}
    }} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();closeFilters();}}}>
      <header><div><SlidersHorizontal size={16}/><strong>筛选日志</strong></div><button type="button" aria-label="关闭日志筛选" onClick={closeFilters}><X size={16}/></button></header>
      <fieldset className="journal-filter-section">
        <legend>日期范围</legend>
        <div className="journal-period-options" role="group" aria-label="日期范围">
          <button data-filter-focus="period" type="button" aria-pressed={view.period==="all"} onClick={()=>onUpdate({period:"all",day:""})}>全部日期</button>
          <button type="button" aria-pressed={view.period==="month"} onClick={()=>onUpdate({period:"month",day:""})}>按月</button>
          <button type="button" aria-pressed={view.period==="day"} onClick={()=>onUpdate({period:"day",day:view.day||defaultDay})}>指定日期</button>
        </div>
        {view.period==="month"&&<div className="journal-date-choice"><label htmlFor={`${uid}-month`}>月份</label><input id={`${uid}-month`} type="month" aria-label="筛选月份" value={view.month} onChange={event=>{if(event.target.value)onUpdate({month:event.target.value});}}/><button type="button" onClick={()=>onUpdate({month:currentMonth})} disabled={view.month===currentMonth}>本月</button></div>}
        {view.period==="day"&&<div className="journal-date-choice"><label htmlFor={`${uid}-day`}>日期</label><input id={`${uid}-day`} type="date" aria-label="筛选日期" value={view.day} onChange={event=>{if(event.target.value)onUpdate({day:event.target.value,month:event.target.value.slice(0,7)});}}/><button type="button" onClick={()=>onUpdate({day:localJournalDate(),month:currentMonth})} disabled={view.day===localJournalDate()}>今天</button></div>}
      </fieldset>
      <fieldset className="journal-filter-section">
        <legend>资料库<span>可多选</span></legend>
        <button data-filter-focus="libraries" type="button" className="journal-all-libraries" aria-pressed={view.libraries===null} onClick={()=>onUpdate({libraries:null})}><span>全部资料库</span>{view.libraries===null&&<Check size={15}/>}</button>
        <div className="journal-library-options">{libraries.map(library=><label key={library.id}><input type="checkbox" checked={view.libraries?.includes(library.id)||false} onChange={()=>toggleLibrary(library.id)}/><span>{libraryName(library.id)}</span></label>)}</div>
        {view.libraries?.length===0?<p className="journal-filter-empty-selection" role="status">未选择资料库。勾选资料库或选择「全部资料库」。</p>:view.libraries===null&&<p className="journal-filter-help">当前不限资料库；勾选后只看所选范围。</p>}
      </fieldset>
      <fieldset className="journal-filter-section">
        <legend>内容类型</legend>
        <div className="journal-record-options">{Object.entries(journalRecordFilters).map(([key,label],index)=><label key={key}><input data-filter-focus={index===0?"record":undefined} type="radio" name={`${uid}-record-type`} checked={view.recordFilter===key} onChange={()=>onUpdate({recordFilter:key as JournalRecordFilter})}/><span>{label}</span></label>)}</div>
      </fieldset>
      <footer><span>选择后立即生效</span><button type="button" disabled={!filterCount} onClick={clearFilters}><RotateCcw size={13}/>清除筛选</button><button type="button" className="journal-filter-done" onClick={closeFilters}>完成</button></footer>
    </div>

    <dialog ref={saveDialog} id={saveId} className="journal-save-view-dialog" aria-labelledby={`${saveId}-title`} onCancel={event=>{event.preventDefault();closeSave();}} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();closeSave();}}}>
      <form onSubmit={event=>{
        event.preventDefault();
        const name=saveName.trim();
        if(!name)return;
        if(store.saved.some(saved=>saved.name.toLocaleLowerCase()===name.toLocaleLowerCase())){setSaveError("已有同名视图，请换一个名称。");saveInput.current?.focus();return;}
        if(store.saved.length>=30){setSaveError("最多保存 30 个视图，请先在视图设置中整理已有视图。");return;}
        store.save(name);closeSave();
      }}>
        <header><h2 id={`${saveId}-title`}>保存为新视图</h2><button type="button" aria-label="关闭新建视图" onClick={closeSave}><X size={17}/></button></header>
        <p>保存当前布局和筛选，下次可以直接切换。</p>
        <label htmlFor={`${uid}-view-name`}>视图名称</label>
        <input ref={saveInput} id={`${uid}-view-name`} aria-label="新视图名称" aria-invalid={!!saveError} aria-describedby={saveError?`${uid}-view-error`:undefined} value={saveName} onChange={event=>{setSaveName(event.target.value);setSaveError("");}} maxLength={60} autoComplete="off" required/>
        {saveError&&<p id={`${uid}-view-error`} className="journal-view-error" role="alert">{saveError}</p>}
        <footer><button type="button" onClick={closeSave}>取消</button><button type="submit" className="journal-save-view-submit" disabled={!saveName.trim()}>创建视图</button></footer>
      </form>
    </dialog>
  </section>;
}
