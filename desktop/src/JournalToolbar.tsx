import {useEffect,useId,useRef,useState,type ReactNode} from "react";
import {ArrowLeft,CalendarDays,Check,ChevronDown,ChevronRight,Layers,ListFilter,Plus,Search,SlidersHorizontal,Trash2,X} from "lucide-react";
import {journalRecordFilters,type JournalRecordFilter} from "./JournalRecords";
import {JournalViewManager} from "./JournalViewManager";
import {journalLayouts,localJournalDate,shiftJournalDay,type JournalViewConfig,type JournalViewStore} from "./JournalViews";

import {useContext} from "react";
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

type FilterProperty="period"|"libraries"|"record";
type FilterStage="properties"|FilterProperty;
type DateEditor="month"|"day"|null;
const propertyLabels:Record<FilterProperty,string>={period:"日期",libraries:"资料库",record:"内容类型"};
const propertyIcons={period:CalendarDays,libraries:Layers,record:ListFilter};
const monthLabel=(month:string)=>`${month.slice(0,4)}年${Number(month.slice(5,7))}月`;
const dateLabel=(day:string)=>`${day.slice(0,4)}年${Number(day.slice(5,7))}月${Number(day.slice(8,10))}日`;

export function JournalToolbar({store,libraries,resultCount,taskCount=0,loading=false,error=false,onUpdate,onCreate}:Props){
  const shell=useContext(WorkspaceHeaderContext);
  const knownLibraryIds=new Set(libraries.map(library=>library.id));
  const {view}=store;
  const uid=useId(),filterId=`journal-filters-${uid}`,conditionsId=`journal-conditions-${uid}`,saveId=`journal-save-view-${uid}`;
  const filterPanel=useRef<HTMLDivElement>(null),filterButton=useRef<HTMLButtonElement>(null),filterReturn=useRef<HTMLElement|null>(null);
  const panelFocus=useRef<string|null>(null),searchInput=useRef<HTMLInputElement>(null),searchButton=useRef<HTMLButtonElement>(null);
  const restoreSearchFocus=useRef(false);
  const saveDialog=useRef<HTMLDialogElement>(null),saveInput=useRef<HTMLInputElement>(null),saveReturn=useRef<HTMLElement|null>(null);
  const [filtersOpen,setFiltersOpen]=useState(false),[stage,setStage]=useState<FilterStage>("properties"),[focusRequest,setFocusRequest]=useState(0);
  const [dateEditor,setDateEditor]=useState<DateEditor>(null),[draftMonth,setDraftMonth]=useState(""),[draftDay,setDraftDay]=useState("");
  const [extraLibraryIds,setExtraLibraryIds]=useState<string[]>([]),[searchExpanded,setSearchExpanded]=useState(false);
  const [saveName,setSaveName]=useState(""),[saveError,setSaveError]=useState("");
  const unknownIds=[...new Set([...extraLibraryIds,...(view.libraries||[])])].filter(id=>!knownLibraryIds.has(id));
  const libraryName=(id:string)=>{const library=libraries.find(value=>value.id===id);const providerNames:Record<string,string>={craft:"Craft",obsidian:"Obsidian",dida365:"滴答清单"};return library?`${library.name} · ${providerNames[library.provider]||library.provider}`:`未连接资料库 ${unknownIds.indexOf(id)+1}`;};
  const previousView=useRef(store.activeId);
  const filterCount=Number(view.period!=="all")+Number(view.libraries!==null)+Number((view.recordFilter||"all")!=="all");
  const showSearch=searchExpanded||!!view.query;
  const currentMonth=localJournalDate().slice(0,7);
  const periodLabel=view.period==="day"?dateLabel(view.day):view.month===currentMonth?`${Number(view.month.slice(5))}月 · 本月`:monthLabel(view.month);
  const sourceLabel=view.libraries===null?"全部资料库":view.libraries.length===0?"未选择资料库":view.libraries.length===1?libraryName(view.libraries[0]):`${view.libraries.length} 个资料库`;
  const sourceTitle=view.libraries?.length?view.libraries.map(libraryName).join("、"):sourceLabel;
  const libraryOptions=[...libraries.map(library=>({id:library.id,label:libraryName(library.id)})),...unknownIds.map(id=>({id,label:libraryName(id)}))];
  const propertyActive=(property:FilterProperty)=>property==="period"?view.period!=="all":property==="libraries"?view.libraries!==null:(view.recordFilter||"all")!=="all";
  const propertyValue=(property:FilterProperty)=>property==="period"?periodLabel:property==="libraries"?sourceLabel:journalRecordFilters[view.recordFilter||"all"];

  function focusFilterTrigger(){
    requestAnimationFrame(()=>{
      const trigger=filterReturn.current;
      if(trigger?.isConnected)trigger.focus({preventScroll:true});
      else filterButton.current?.focus({preventScroll:true});
    });
  }
  function positionFilters(){
    const panel=filterPanel.current,trigger=filterReturn.current?.isConnected?filterReturn.current:filterButton.current;
    if(!panel||!trigger||!panel.matches(":popover-open"))return;
    const viewport=window.visualViewport;
    const left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0,width=viewport?.width||window.innerWidth,height=viewport?.height||window.innerHeight;
    const desiredWidth=panel.dataset.stage==="properties"?276:panel.dataset.stage==="period"?320:300;
    const panelWidth=Math.min(desiredWidth,width-24),rect=trigger.getBoundingClientRect();
    const setStyle=(property:"width"|"maxHeight"|"left"|"top",value:number)=>{
      const pixels=`${Math.round(value*100)/100}px`;
      if(panel.style[property]!==pixels)panel.style[property]=pixels;
    };
    setStyle("width",panelWidth);
    setStyle("maxHeight",Math.max(100,height-24));
    const preferredLeft=trigger===filterButton.current?rect.right-panelWidth:rect.left;
    setStyle("left",Math.max(left+12,Math.min(preferredLeft,left+width-panelWidth-12)));
    const below=rect.bottom+7,above=rect.top-panel.offsetHeight-7;
    const preferredTop=below+panel.offsetHeight<=top+height-12?below:above>=top+12?above:top+height-panel.offsetHeight-12;
    setStyle("top",Math.max(top+12,preferredTop));
  }
  function requestPanelFocus(selector:string){panelFocus.current=selector;setFocusRequest(n=>n+1);}
  function prepareEditor(property:FilterProperty){
    if(property==="period"){
      setDateEditor(view.period==="all"?null:view.period);
      setDraftMonth(view.period==="month"?view.month:"");
      setDraftDay(view.period==="day"?view.day:"");
    }
    if(property==="libraries")setExtraLibraryIds((view.libraries||[]).filter(id=>!knownLibraryIds.has(id)));
  }
  function openPanel(trigger:HTMLElement,next:FilterStage="properties"){
    filterReturn.current=trigger;
    if(next!=="properties")prepareEditor(next);
    setStage(next);
    requestPanelFocus(next==="properties"?'[data-property="period"]':'[data-editor-initial]');
    if(!filterPanel.current?.matches(":popover-open"))filterPanel.current?.showPopover();
  }
  function editProperty(property:FilterProperty){
    prepareEditor(property);setStage(property);requestPanelFocus('[data-editor-initial]');
  }
  function backToProperties(){const previous=stage;setStage("properties");requestPanelFocus(`[data-property="${previous}"]`);}
  function closeFilters(restoreFocus=true){
    filterPanel.current?.hidePopover?.();
    if(restoreFocus)focusFilterTrigger();
  }
  function removeProperty(property:FilterProperty){
    const patch:Partial<JournalViewConfig>=property==="period"?{period:"all",day:""}:property==="libraries"?{libraries:null}:{recordFilter:"all"};
    onUpdate(patch);
    closeFilters(false);
    requestAnimationFrame(()=>filterButton.current?.focus({preventScroll:true}));
  }
  function clearFilters(){
    onUpdate({period:"all",day:"",libraries:null,recordFilter:"all"});
    closeFilters(false);
    requestAnimationFrame(()=>filterButton.current?.focus({preventScroll:true}));
  }
  useEffect(()=>{
    let positionFrame:number|null=null;
    const schedulePosition=()=>{
      if(positionFrame!==null)return;
      positionFrame=requestAnimationFrame(()=>{positionFrame=null;positionFilters();});
    };
    const panel=filterPanel.current,observer=panel&&typeof ResizeObserver!=="undefined"?new ResizeObserver(schedulePosition):null;
    if(panel)observer?.observe(panel);
    window.addEventListener("resize",schedulePosition);window.addEventListener("scroll",schedulePosition,true);
    window.visualViewport?.addEventListener("resize",schedulePosition);window.visualViewport?.addEventListener("scroll",schedulePosition);
    return()=>{observer?.disconnect();if(positionFrame!==null)cancelAnimationFrame(positionFrame);window.removeEventListener("resize",schedulePosition);window.removeEventListener("scroll",schedulePosition,true);window.visualViewport?.removeEventListener("resize",schedulePosition);window.visualViewport?.removeEventListener("scroll",schedulePosition);};
  },[]);
  useEffect(()=>{
    if(!filtersOpen)return;
    positionFilters();
    const selector=panelFocus.current;
    if(selector){panelFocus.current=null;filterPanel.current?.querySelector<HTMLElement>(selector)?.focus({preventScroll:true});}
  },[filtersOpen,stage,dateEditor,focusRequest]);
  useEffect(()=>{
    if(previousView.current===store.activeId)return;
    previousView.current=store.activeId;
    filterPanel.current?.hidePopover?.();
  },[store.activeId]);

  useEffect(()=>{
    if(searchExpanded)searchInput.current?.focus({preventScroll:true});
    else if(restoreSearchFocus.current){restoreSearchFocus.current=false;searchButton.current?.focus({preventScroll:true});}
  },[searchExpanded]);
  function openSearch(){setSearchExpanded(true);}
  function closeSearch(){onUpdate({query:""});restoreSearchFocus.current=true;setSearchExpanded(false);}
  function startSave(){
    saveReturn.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const base=journalLayouts[view.layout];let name:string=base,index=2;
    while(store.saved.some(saved=>saved.name===name))name=`${base} ${index++}`;
    setSaveName(name);setSaveError("");saveDialog.current?.showModal();
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
  function chooseDateEditor(mode:Exclude<DateEditor,null>){setDateEditor(mode);requestPanelFocus(mode==="month"?'[data-date-input="month"]':'[data-date-input="day"]');}
  function chip(property:FilterProperty,label:string,icon:ReactNode,title=label){
    const description=`${propertyLabels[property]}：${title}`;
    return <div className="journal-filter-chip" title={description}>
      <button type="button" onClick={event=>openPanel(event.currentTarget,property)} aria-haspopup="dialog" aria-controls={filterId} aria-expanded={filtersOpen&&stage===property} aria-label={`编辑筛选：${description}`}>{icon}<span>{label}</span><ChevronDown size={12}/></button>
      <button type="button" className="journal-chip-clear" aria-label={`移除筛选：${description}`} onClick={()=>removeProperty(property)}><X size={12}/></button>
    </div>;
  }

  return <section className={`journal-toolbar-shell${showSearch?" is-searching":""}`} aria-label="日志视图与筛选工具栏">
    <div className="journal-toolbar-top" onMouseDown={shell?.onMouseDown}>
      <JournalViewManager store={store} onNew={startSave}/>
      <p className="journal-toolbar-results" role="status" aria-live="polite" aria-atomic="true" title={`${resultCount} 条日志${taskCount?` · ${taskCount} 项任务`:""}`}><span>{error?"结果读取失败":loading?"正在读取…":<><strong>{resultCount}</strong> 条日志</>}</span>{taskCount>0&&<span className="journal-toolbar-task-count"> · {taskCount} 项任务</span>}</p>
      <div className="journal-toolbar-actions">{shell?.actions}
        {showSearch?<label className="journal-toolbar-search" data-hub-keyboard-scope="journal-search" onBlur={event=>{if(!view.query&&!(event.relatedTarget instanceof Node&&event.currentTarget.contains(event.relatedTarget)))setSearchExpanded(false);}}>
          <Search size={15}/><span className="journal-toolbar-sr-only">搜索日志内容</span>
          <input ref={searchInput} type="search" aria-label="搜索日志内容" placeholder="搜索日志…" value={view.query} onChange={event=>onUpdate({query:event.target.value})} onKeyDown={event=>{
            if(event.key!=="Escape"||event.nativeEvent.isComposing)return;
            event.preventDefault();event.stopPropagation();
            if(view.query){onUpdate({query:""});setSearchExpanded(true);}
            else closeSearch();
          }}/>
          <button type="button" aria-label={view.query?"清空并关闭日志搜索":"关闭日志搜索"} title={view.query?"清空并关闭搜索":"关闭搜索"} onClick={closeSearch}><X size={14}/></button>
        </label>:<button ref={searchButton} type="button" className="journal-search-trigger" aria-label="搜索日志" title="搜索日志" aria-expanded="false" onClick={openSearch}><Search size={16}/></button>}
        <button ref={filterButton} type="button" className={`journal-filter-trigger ${filterCount?"has-filters":""}`} aria-label={`筛选日志${filterCount?`，${filterCount}项条件`:""}`} title="添加或编辑筛选条件" aria-haspopup="dialog" aria-controls={filterId} aria-expanded={filtersOpen} onClick={event=>openPanel(event.currentTarget)}>
          <SlidersHorizontal size={15}/><span>筛选</span>{filterCount>0&&<span className="journal-filter-count">{filterCount}</span>}
        </button>
        {onCreate&&<button type="button" className="journal-toolbar-create" onClick={event=>onCreate(event.currentTarget)} aria-label="写日志" title="写日志"><Plus size={15}/><span>写日志</span></button>}
      </div>
    </div>
    {filterCount>0&&<div id={conditionsId} className="journal-toolbar-conditions" aria-label="已生效的日志筛选">
      {view.period!=="all"&&chip("period",periodLabel,<CalendarDays size={13}/>)}
      {view.libraries!==null&&chip("libraries",sourceLabel,<Layers size={13}/>,sourceTitle)}
      {(view.recordFilter||"all")!=="all"&&chip("record",journalRecordFilters[view.recordFilter||"all"],<ListFilter size={13}/>)}
      <button type="button" className="journal-add-filter" aria-haspopup="dialog" aria-controls={filterId} onClick={event=>openPanel(event.currentTarget)}><Plus size={13}/><span>添加筛选</span></button>
      <button type="button" className="journal-clear-filters" onClick={clearFilters} title="移除全部筛选条件，保留临时搜索词">清除全部</button>
    </div>}

    <div ref={filterPanel} id={filterId} data-stage={stage} className="journal-filter-popover" data-hub-keyboard-scope="journal-filter" data-keyboard-open={filtersOpen} popover="auto" role="dialog" aria-label={stage==="properties"?"选择筛选属性":`编辑${propertyLabels[stage]}筛选`} onToggle={event=>{
      const shown=event.currentTarget.matches(":popover-open");setFiltersOpen(shown);
      if(shown)positionFilters();
    }} onKeyDown={event=>{if(event.key==="Escape"&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();if(stage==="properties")closeFilters();else backToProperties();}}}>
      <header>
        <div>{stage!=="properties"&&<button type="button" className="journal-filter-back" aria-label="返回筛选属性" title="返回属性选择" onClick={backToProperties}><ArrowLeft size={15}/></button>}<strong>{stage==="properties"?"添加筛选":propertyLabels[stage]}</strong></div>
        <button type="button" aria-label="关闭日志筛选" onClick={()=>closeFilters()}><X size={15}/></button>
      </header>
      {stage==="properties"?<div className="journal-filter-properties">
        {(["period","libraries","record"] as const).map(property=>{
          const Icon=propertyIcons[property],active=propertyActive(property);
          return <button key={property} type="button" data-property={property} onClick={()=>editProperty(property)} aria-label={`${propertyLabels[property]}${active?`，已添加：${propertyValue(property)}`:""}`}><Icon size={16}/><span><strong>{propertyLabels[property]}</strong>{active&&<small>{propertyValue(property)}</small>}</span>{active&&<span className="journal-filter-added"><Check size={12}/><span>已添加</span></span>}<ChevronRight size={13}/></button>;
        })}
      </div>:<>
        {stage==="period"&&<div className="journal-filter-editor journal-date-editor">
          <div className="journal-date-presets" role="group" aria-label="日期快捷选择">
            <button data-editor-initial type="button" aria-pressed={view.period==="month"&&view.month===currentMonth} onClick={()=>{onUpdate({period:"month",month:currentMonth,day:""});closeFilters();}}>本月{view.period==="month"&&view.month===currentMonth&&<Check size={13}/>}</button>
            <button type="button" aria-pressed={view.period==="day"&&view.day===localJournalDate()} onClick={()=>{onUpdate({period:"day",day:localJournalDate(),month:currentMonth});closeFilters();}}>今天{view.period==="day"&&view.day===localJournalDate()&&<Check size={13}/>}</button>
          </div>
          <div className="journal-date-mode" role="group" aria-label="选择日期条件">
            <button type="button" aria-pressed={dateEditor==="month"} onClick={()=>chooseDateEditor("month")}>指定月份</button>
            <button type="button" aria-pressed={dateEditor==="day"} onClick={()=>chooseDateEditor("day")}>指定日期</button>
          </div>
          {dateEditor==="month"&&<label className="journal-date-choice"><span>月份</span><input data-date-input="month" type="month" aria-label="筛选月份" value={draftMonth} onChange={event=>{
            const month=event.target.value;setDraftMonth(month);
            if(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month))onUpdate({period:"month",month,day:""});
          }}/></label>}
          {dateEditor==="day"&&<label className="journal-date-choice"><span>日期</span><input data-date-input="day" type="date" aria-label="筛选日期" value={draftDay} onChange={event=>{
            const day=event.target.value;setDraftDay(day);
            if(shiftJournalDay(day,0))onUpdate({period:"day",day,month:day.slice(0,7)});
          }}/></label>}
          {!dateEditor&&<p className="journal-filter-help">选择一个日期或月份。</p>}
        </div>}
        {stage==="libraries"&&<div className="journal-filter-editor">
          <button data-editor-initial type="button" className="journal-all-libraries" aria-pressed={view.libraries===null} onClick={()=>{onUpdate({libraries:null});closeFilters();}}><span>全部资料库</span>{view.libraries===null&&<Check size={15}/>}</button>
          <div className="journal-library-options" role="group" aria-label="选择资料库，可多选">{libraryOptions.map(library=><label key={library.id}><input type="checkbox" checked={view.libraries?.includes(library.id)||false} onChange={()=>toggleLibrary(library.id)}/><span>{library.label}</span></label>)}</div>
          {view.libraries?.length===0?<p className="journal-filter-empty-selection" role="status">未选择资料库，当前不会显示记录。</p>:view.libraries===null?<p className="journal-filter-help">当前不限资料库。勾选后只看所选范围。</p>:<p className="journal-filter-help">可选择多个资料库。</p>}
        </div>}
        {stage==="record"&&<div className="journal-filter-editor">
          <div className="journal-record-options" role="group" aria-label="日志内容类型" onKeyDown={event=>{if(event.key==="Enter"&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();closeFilters();}}}>{Object.entries(journalRecordFilters).map(([key,label])=><label key={key}><input data-editor-initial={(view.recordFilter||"all")===key?true:undefined} type="radio" name={`${uid}-record-type`} checked={(view.recordFilter||"all")===key} onChange={()=>onUpdate({recordFilter:key as JournalRecordFilter})}/><span>{label}</span></label>)}</div>
        </div>}
        <footer><button type="button" className="journal-filter-remove" disabled={!propertyActive(stage)} onClick={()=>removeProperty(stage)}><Trash2 size={13}/><span>移除此条件</span></button><button type="button" className="journal-filter-done" onClick={()=>closeFilters()}>完成</button></footer>
      </>}
    </div>

    <dialog ref={saveDialog} id={saveId} className="journal-save-view-dialog" aria-labelledby={`${saveId}-title`} onCancel={event=>{event.preventDefault();closeSave();}} onKeyDown={event=>{if(event.key==="Escape"&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();closeSave();}}}>
      <form onSubmit={event=>{
        event.preventDefault();const name=saveName.trim();if(!name)return;
        if(store.saved.some(saved=>saved.name.toLocaleLowerCase()===name.toLocaleLowerCase())){setSaveError("已有同名视图，请换一个名称。");saveInput.current?.focus();return;}
        if(store.saved.length>=30){setSaveError("最多保存 30 个视图，请先在视图设置中整理已有视图。");return;}
        store.save(name);closeSave();
      }}>
        <header><h2 id={`${saveId}-title`}>保存为新视图</h2><button type="button" aria-label="关闭新建视图" onClick={closeSave}><X size={17}/></button></header>
        <p>保存当前布局和筛选条件。临时搜索词不会保存在视图中。</p>
        <label htmlFor={`${uid}-view-name`}>视图名称</label>
        <input ref={saveInput} id={`${uid}-view-name`} aria-label="新视图名称" aria-invalid={!!saveError} aria-describedby={saveError?`${uid}-view-error`:undefined} value={saveName} onChange={event=>{setSaveName(event.target.value);setSaveError("");}} maxLength={60} autoComplete="off" required/>
        {saveError&&<p id={`${uid}-view-error`} className="journal-view-error" role="alert">{saveError}</p>}
        <footer><button type="button" onClick={closeSave}>取消</button><button type="submit" className="journal-save-view-submit" disabled={!saveName.trim()}>创建视图</button></footer>
      </form>
    </dialog>
  </section>;
}
