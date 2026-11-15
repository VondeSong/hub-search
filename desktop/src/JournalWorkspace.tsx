import { runtimeCapabilities } from "./RuntimePlatform";
import { CalendarDays, ExternalLink, ListFilter, Plus, Search, Star, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { journalEntryTitle } from "./JournalPresentation";
import { pageFavoriteKey } from "./PageFavorites";
import { cleanSearchSnippet } from "./ResultExcerpt";
import { journalDateKey, journalDateLabel } from "./SearchWorkspacePresentation";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import { journalLayouts, journalMonthDays, localJournalDate, useJournalViews } from "./JournalViews";
import { useJournalPage } from "./useJournalPage";
import { QuickJournal, QuickJournalCard } from "./QuickJournal";
import { JournalDailyStream } from "./JournalDailyStream";
import { JournalViewManager } from "./JournalViewManager";
import { JournalCapturePanel } from "./JournalCapturePanel";
import { JournalRecordCard } from "./JournalRecordCard";
import { journalHeatLevel,journalRecordFilters,journalRecordMatches,journalDocumentKey,journalIndexInView,useJournalRecords } from "./JournalRecords";
import "./JournalDatabase.css";
import "./JournalCalendarAlignment.css";

const modifiedLabel=(result:SearchResult)=>result.modifiedAt?new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(result.modifiedAt<1e12?result.modifiedAt*1000:result.modifiedAt)):"—";
function entrySummary(result:SearchResult){return cleanSearchSnippet(result.snippet).replace(/<\/?[a-z][^>]*$/i, "").replace(/^\d{4}[-.]\d{2}[-.]\d{2}\s*/,"").trim();}

export type JournalWorkspaceProps={
  libraries:LibrarySummary[];scope:string[]|null;dataVersion:string;selectedDate:string;
  selectedKey?:string;onNavigateDate?:(date:string)=>void;onPreview:(result:SearchResult)=>void;
  onOpen:(result:SearchResult)=>void;onCreate?:(date:string)=>void;
  renderIcon:(result:SearchResult,name:string)=>ReactNode;favoriteIds?:Set<string>;onFavorite?:(result:SearchResult)=>void;
};
export function JournalWorkspace(props:JournalWorkspaceProps){
  const store=useJournalViews();
  if(!store)return null;
  return <JournalDatabase {...props} store={store}/>;
}
function JournalDatabase({libraries,scope,dataVersion,selectedDate,selectedKey,onNavigateDate,onPreview,onOpen,renderIcon,favoriteIds,onFavorite,store}:JournalWorkspaceProps&{store:NonNullable<ReturnType<typeof useJournalViews>>}){
  const records=useJournalRecords();
  const [captureDay,setCaptureDay]=useState("");
  const createRecord=(date:string)=>setCaptureDay(date);
  const view=runtimeCapabilities.mobile?{...store.view,layout:"records" as const,recordFilter:"all" as const,period:store.view.period==="month"?"all" as const:store.view.period,ascending:false}:store.view;const today=localJournalDate();
  const page=useJournalPage(view,scope,dataVersion,view.layout!=="stream");
  const root=useRef<HTMLDivElement>(null),body=useRef<HTMLDivElement>(null),menu=useRef<HTMLDetailsElement>(null),recordSearch=useRef<HTMLInputElement>(null),saveInput=useRef<HTMLInputElement>(null);
  const [filters,setFilters]=useState(false),[saveMode,setSaveMode]=useState<"save"|"rename"|null>(null),[name,setName]=useState("");
  const [query,setQuery]=useState(view.query),[chosenDay,setChosenDay]=useState(""),[pickedKey,setPickedKey]=useState("");
  const [expandedDays,setExpandedDays]=useState<Set<string>>(new Set());
  const previousNavigation=useRef(selectedDate),sessionPosition=useRef(new Map<string,number>());
  const sessionKey=`${view.layout}:${view.month}:${view.period}:${view.day}:${view.query}:${JSON.stringify(view.libraries)}`;
  const previousSession=useRef(sessionKey),consumedAnchor=useRef("");
  useEffect(()=>{if(previousNavigation.current!==selectedDate){previousNavigation.current=selectedDate;if(selectedDate){store.navigate(selectedDate.length===7?`${selectedDate}-01`:selectedDate);if(view.layout==="calendar")setChosenDay(selectedDate.length===10?selectedDate:"");}}},[selectedDate]);
  useEffect(()=>{setChosenDay(view.layout==="calendar"&&selectedDate===store.anchor&&store.anchor.length===10?store.anchor:"");},[view.month,store.activeId]);
  useEffect(()=>{setQuery(view.query);},[view.query]);
  useEffect(()=>{if(query===view.query)return;const timer=setTimeout(()=>store.update({query}),220);return()=>clearTimeout(timer);},[query,view.query]);
  useEffect(()=>{if(view.layout!=="records"||runtimeCapabilities.mobile)return;const key=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){event.preventDefault();event.stopImmediatePropagation();recordSearch.current?.focus();}};window.addEventListener("keydown",key,true);return()=>window.removeEventListener("keydown",key,true);},[view.layout]);
  useEffect(()=>{if(saveMode)saveInput.current?.focus();},[saveMode]);
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(menu.current?.open&&!menu.current.contains(event.target as Node))menu.current.open=false;};
    document.addEventListener("pointerdown",close);return()=>document.removeEventListener("pointerdown",close);
  },[]);
  useEffect(()=>{
    if(page.loading)return;
    const pane=body.current;if(!pane)return;
    if(previousSession.current!==sessionKey){pane.scrollTop=sessionPosition.current.get(sessionKey)||0;previousSession.current=sessionKey;}
    const pendingAnchor=store.anchor!==consumedAnchor.current?store.anchor:"";
    const target=pendingAnchor;
    if(target){
      const element=pane.querySelector<HTMLElement>(`[data-journal-day="${target}"]`);
      if(element){pane.scrollTop=Math.max(0,element.offsetTop-pane.offsetTop-12);consumedAnchor.current=store.anchor;}
    }
  },[page.loading,store.anchor,sessionKey]);
  const supported=libraries.filter(l=>(l.provider==="craft"||l.provider==="obsidian")&&(scope===null||scope.includes(l.id)));
  const taskLibraries=libraries.filter(l=>(l.provider==="craft"||l.provider==="obsidian"||l.provider==="dida365")&&(scope===null||scope.includes(l.id)));
  const grouped=useMemo(()=>{
    const groups=new Map<string,SearchResult[]>();
    page.items.filter(item=>{const indexed=records.index.find(v=>v.id===journalDocumentKey(item.libraryId,item.documentId));return !indexed?.representedByQuick&&indexed?.matchesQuery!==false&&(!view.recordFilter||view.recordFilter==="all"||!!indexed&&journalRecordMatches(indexed,view.recordFilter,records.pins));}).forEach(item=>{const date=journalDateKey(item);if(date&&(view.layout!=="calendar"||date.startsWith(view.month))){const values=groups.get(date)||[];values.push(item);groups.set(date,values);}});
    return groups;
  },[page.items,records.index,records.pins,view.recordFilter,view.month,view.layout]);
  const visibleQuick=records.items.filter(item=>{const meta={id:item.record.id,date:item.record.date,libraryId:item.libraryId,hasAttachments:item.record.attachments.length>0,hasTags:/(?:^|\s)#[^\s#]+/u.test(item.body)};return journalIndexInView(meta,view,scope)&&journalRecordMatches(meta,view.recordFilter||"all",records.pins)&&`${item.body} ${item.record.attachments.map(a=>a.name).join(" ")}`.toLowerCase().includes(view.query.trim().toLowerCase());});
  const quickCards=(date:string)=><div className="journal-record-feed">{visibleQuick.filter(item=>item.record.date===date).map(item=><QuickJournalCard key={item.record.id} item={item} mobile={false} onPreview={onPreview} onTag={tag=>store.update({query:"#"+tag})}/>)}</div>;
  const feed=[...[...grouped.values()].flat().map(entry=>({id:journalDocumentKey(entry.libraryId,entry.documentId),date:journalDateKey(entry),node:<JournalRecordCard key={entry.entityKey} entry={entry} summary={view.summary} source={view.source} onPreview={entry=>preview(entry)} onOpen={onOpen}/>})),...visibleQuick.map(item=>({id:item.record.id,date:item.record.date,node:<QuickJournalCard key={item.record.id} item={item} mobile={false} onPreview={onPreview} onTag={tag=>store.update({query:"#"+tag})}/>}))].sort((a,b)=>Number(records.pins.has(b.id))-Number(records.pins.has(a.id))||b.date.localeCompare(a.date));
  const choose=(date:string)=>{setChosenDay(date);store.navigate(date);onNavigateDate?.(date);};
  const preview=(result:SearchResult)=>{if(page.loading)return;setPickedKey(result.entityKey);onPreview(result);};
  const selected=selectedKey||pickedKey;
  const closeMenu=()=>{if(menu.current){const wasOpen=menu.current.open;menu.current.open=false;if(wasOpen)menu.current.querySelector("summary")?.focus();}};
  const openSave=(mode:"save"|"rename",suggestion?:string)=>{closeMenu();setSaveMode(mode);setName(suggestion||(mode==="rename"?store.active?.name:journalLayouts[view.layout])||"");};
  const cards=(date:string,entries:SearchResult[],limit=4)=>{
    const expanded=expandedDays.has(date);const displayed=expanded?entries:entries.slice(0,limit);
    return <><div className="journal-day-cards">{displayed.map(result=><article key={result.entityKey} className={`journal-entry-card ${selected===result.entityKey?"is-selected":""}`}>
      <button className="journal-entry-open" disabled={page.loading} onClick={()=>preview(result)} aria-label={`预览 ${journalEntryTitle(result)} · ${result.libraryName}`} aria-pressed={selected===result.entityKey}>
        <span className="journal-entry-title">{renderIcon(result,result.libraryName)}<strong>{journalEntryTitle(result)}</strong></span>
        {view.summary&&entrySummary(result)!==journalEntryTitle(result)&&<span className="journal-entry-summary">{entrySummary(result)||"暂无摘要"}</span>}
        {(view.source||view.modified)&&<span className="journal-entry-meta">{view.source&&<span>{result.libraryName}</span>}{view.modified&&<span>更新于 {modifiedLabel(result)}</span>}</span>}
      </button>
      <div className="journal-entry-actions">{onFavorite&&<button aria-label={`${favoriteIds?.has(pageFavoriteKey(result))?"取消收藏":"收藏"} ${journalEntryTitle(result)}`} aria-pressed={favoriteIds?.has(pageFavoriteKey(result))||false} onClick={()=>onFavorite(result)}><Star size={14} fill={favoriteIds?.has(pageFavoriteKey(result))?"currentColor":"none"}/></button>}<button onClick={()=>onOpen(result)} aria-label={`在来源中打开 ${journalEntryTitle(result)}`}><ExternalLink size={14}/></button></div>
    </article>)}</div>{entries.length>limit&&<button className="journal-expand-day" aria-expanded={expanded} onClick={()=>setExpandedDays(current=>{const next=new Set(current);if(next.has(date))next.delete(date);else next.add(date);return next;})}>{expanded?"收起":"展开其余 "+(entries.length-limit)+" 篇"}</button>}</>;
  };
  const emptyDay=(date:string)=><div className="journal-empty-day"><span>{journalDateLabel(date)} · 暂无日志</span>{!runtimeCapabilities.mobile&&<button onClick={()=>createRecord(date)}><Plus size={14}/>写这一天</button>}</div>;
  const calendar=()=>{
    const dates=journalMonthDays(view.month,true);
    return <><div className="journal-db-calendar"><div className="journal-month-week">{["日","一","二","三","四","五","六"].map(d=><span key={d}>{d}</span>)}</div><div className="journal-month-grid">{dates.map(date=>{const entries=grouped.get(date)||[];return <section data-heat={journalHeatLevel(records.index.length?records.index.filter(item=>!item.representedByQuick&&item.date===date).length:entries.length+visibleQuick.filter(i=>i.record.date===date).length)} className={`journal-month-cell ${date.slice(0,7)!==view.month?"outside-month":""} ${date===today?"today":""} ${chosenDay===date?"selected":""}`} key={date}><button className="journal-month-date" onClick={()=>{setChosenDay(date);}} aria-label={`${journalDateLabel(date)}，${entries.length+visibleQuick.filter(item=>item.record.date===date).length}条记录`} aria-pressed={chosenDay===date}>{Number(date.slice(8))}{date===today&&<span>今天</span>}</button><span className="journal-month-count">{entries.length+visibleQuick.filter(item=>item.record.date===date).length||""}</span>{entries.slice(0,3).map(result=><button key={result.entityKey} className={`journal-month-entry ${selected===result.entityKey?"is-selected":""}`} disabled={page.loading} onClick={()=>preview(result)} title={`${result.libraryName} · ${journalEntryTitle(result)}`}>{view.source&&<small>{result.libraryName}</small>}<span>{journalEntryTitle(result)}</span></button>)}{visibleQuick.filter(item=>item.record.date===date).slice(0,3).map(item=><button className="journal-month-entry" key={item.record.id} onClick={()=>setChosenDay(date)}><span>{item.body.split("\n")[0]||"附件记录"}</span></button>)}{entries.length>3&&<button onClick={()=>setChosenDay(date)}>还有 {entries.length-3} 篇</button>}</section>;})}</div></div>{chosenDay&&<section className="journal-day-agenda"><header><strong>{journalDateLabel(chosenDay)}</strong><button aria-label="关闭当天日志" onClick={()=>setChosenDay("")}><X size={16}/></button></header>{cards(chosenDay,grouped.get(chosenDay)||[],Number.MAX_SAFE_INTEGER)}{quickCards(chosenDay)}{!grouped.get(chosenDay)?.length&&!visibleQuick.some(item=>item.record.date===chosenDay)&&emptyDay(chosenDay)}<button onClick={()=>{store.update({period:"day",day:chosenDay,layout:"list"});}}>仅看这一天</button></section>}</>;
  };
  const list=()=>{
    const allDays=new Map(grouped);for(const item of visibleQuick)if(!allDays.has(item.record.date))allDays.set(item.record.date,[]);const groups=[...allDays.entries()];groups.sort(([a],[b])=>view.ascending?a.localeCompare(b):b.localeCompare(a));
    return <div className="journal-db-list">{groups.map(([date,entries])=><section className="journal-list-day" key={date} data-journal-day={date}><header><button onClick={()=>choose(date)}>{journalDateLabel(date)}</button><small>{entries.length} 篇日志</small></header>{entries.map(result=><div className={`journal-list-row ${selected===result.entityKey?"is-selected":""}`} key={result.entityKey}><button disabled={page.loading} title={journalEntryTitle(result)} aria-label={`预览 ${journalEntryTitle(result)} · ${result.libraryName}`} aria-pressed={selected===result.entityKey} onClick={()=>preview(result)}>{renderIcon(result,result.libraryName)}<span><strong>{journalEntryTitle(result)}</strong>{view.summary&&entrySummary(result)!==journalEntryTitle(result)&&<small>{entrySummary(result)||"暂无摘要"}</small>}</span>{view.source&&<em>{result.libraryName}</em>}</button><button onClick={()=>onOpen(result)} aria-label={`在来源中打开 ${journalEntryTitle(result)}`}><ExternalLink size={14}/></button></div>)}{quickCards(date)}</section>)}</div>;
  };
  const table=()=> <div className="journal-db-table-wrap"><table aria-label="日志表格"><thead><tr><th>标题</th><th><button onClick={()=>store.update({sort:"date",ascending:view.sort==="date"?!view.ascending:true})}>日志日期 {view.sort==="date"?(view.ascending?"↑":"↓"):""}</button></th>{view.source&&<th>资料库</th>}{view.summary&&<th>摘要</th>}{view.modified&&<th><button onClick={()=>store.update({sort:"modified",ascending:view.sort==="modified"?!view.ascending:false})}>更新时间 {view.sort==="modified"?(view.ascending?"↑":"↓"):""}</button></th>}<th><span className="sr-only">操作</span></th></tr></thead><tbody>{page.items.map(result=><tr key={result.entityKey} className={selected===result.entityKey?"is-selected":""}><td><button className="journal-table-title" disabled={page.loading} onClick={()=>preview(result)}>{renderIcon(result,result.libraryName)}{journalEntryTitle(result)}</button></td><td>{journalDateKey(result)}</td>{view.source&&<td>{result.libraryName}</td>}{view.summary&&<td>{entrySummary(result)||"暂无摘要"}</td>}{view.modified&&<td>{modifiedLabel(result)}</td>}<td><button onClick={()=>onOpen(result)} aria-label={`在来源中打开 ${journalEntryTitle(result)}`}><ExternalLink size={14}/></button></td></tr>)}</tbody></table></div>;
  const filtered=(view.recordFilter&&view.recordFilter!=="all")||!!view.query||view.libraries!==null||view.period==="day";
  if(runtimeCapabilities.mobile)return <div ref={root} className="results-pane journal-database journal-mobile">
    <div ref={body} className="journal-db-body" onScroll={event=>sessionPosition.current.set(sessionKey,event.currentTarget.scrollTop)}>
      <QuickJournal mode="feed" onViewChange={store.update} libraries={libraries} scope={scope} view={view} dataVersion={dataVersion}/>
    </div>
  </div>;
  return <div ref={root} className={`results-pane journal-database ${view.layout==="stream"?"is-daily":view.layout==="records"?"is-memo":""} ${view.compact?"is-compact":""}`}>
    <div className="journal-db-toolbar"><JournalViewManager store={store} onNew={()=>openSave("save")}/><div className="journal-db-tools">{(view.layout==="calendar"||view.layout==="list")&&<button aria-label="新建日志" onClick={()=>createRecord(chosenDay||store.anchor||today)}><Plus size={16}/>写日志</button>}<button aria-label="筛选日志" aria-expanded={filters} aria-pressed={filtered} onClick={()=>setFilters(!filters)}><ListFilter size={17}/></button></div></div>
    {saveMode&&<form className="journal-db-save-form" onSubmit={e=>{e.preventDefault();if(!name.trim())return;if(saveMode==="rename")store.rename(store.activeId,name);else {store.update({query});store.save(name);}setSaveMode(null);}}><label>{saveMode==="rename"?"视图名称":"新视图名称"}<input ref={saveInput} maxLength={60} value={name} onChange={e=>setName(e.target.value)}/></label><button type="submit" disabled={!name.trim()}>保存</button><button type="button" onClick={()=>setSaveMode(null)}>取消</button></form>}
    {store.modified&&<div className="journal-db-filter-summary"><span>当前视图已修改</span><button onClick={()=>{store.update({query});store.updateSaved();}}>更新视图</button><button onClick={()=>openSave("save")}>另存为</button></div>}
    {filters&&<div className="journal-db-filters"><label><Search size={15}/>搜索日志<input aria-label="搜索日志内容" placeholder="搜索正文或资料库" value={query} onChange={e=>setQuery(e.target.value)}/></label><label>内容类型<select aria-label="日志内容类型" value={view.recordFilter||"all"} onChange={e=>store.update({recordFilter:e.target.value as typeof view.recordFilter})}>{Object.entries(journalRecordFilters).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label>日期范围<select aria-label="日志日期范围" value={view.period} onChange={e=>store.update({period:e.target.value as typeof view.period,day:view.day||chosenDay||store.anchor||today})}><option value="month">{view.layout==="stream"?"连续日期":"当前月份"}</option><option value="all">全部日期</option><option value="day">指定日期</option></select></label>{view.period==="day"&&<input type="date" aria-label="日志指定日期" value={view.day} onChange={e=>store.update({day:e.target.value,month:e.target.value.slice(0,7)})}/>}<fieldset><legend>资料库</legend><label><input type="checkbox" checked={view.libraries===null} onChange={()=>store.update({libraries:null})}/>全部资料库</label>{(view.layout==="stream"?taskLibraries:supported).map(l=><label key={l.id}><input type="checkbox" checked={view.libraries===null||view.libraries.includes(l.id)} onChange={e=>{const ids=view.libraries??(view.layout==="stream"?taskLibraries:supported).map(s=>s.id);store.update({libraries:e.target.checked?[...ids,l.id]:ids.filter(id=>id!==l.id)});}}/>{l.name}</label>)}</fieldset></div>}
    {filtered&&<div className="journal-db-filter-summary" aria-label="当前日志筛选条件">{view.recordFilter&&view.recordFilter!=="all"&&<span>{journalRecordFilters[view.recordFilter]}</span>}{view.query&&<span>搜索：{view.query}</span>}{view.libraries!==null&&<span>资料库：{view.libraries.map(id=>libraries.find(l=>l.id===id)?.name||"未连接资料库").join("、")||"未选择"}</span>}{view.period==="day"&&<span>日期：{view.day}</span>}<button onClick={()=>{store.update({query:"",libraries:null,period:"month",day:"",recordFilter:"all"});setQuery("");}}>清除筛选</button></div>}
    {records.error&&<div className="journal-db-status" role="alert">{records.error}<button onClick={records.refresh}>重试记录</button></div>}{view.layout!=="stream"&&page.error&&<div className="journal-db-status" role="alert">{page.error}<button onClick={page.retry}>重试</button></div>}
    <JournalCapturePanel libraries={libraries} day={captureDay} onDay={setCaptureDay} dataVersion={dataVersion} scope={scope} view={view}/><div ref={body} className="journal-db-body" aria-busy={view.layout!=="stream"&&view.layout!=="records"&&page.loading} onScroll={event=>sessionPosition.current.set(sessionKey,event.currentTarget.scrollTop)}>
      {view.layout==="records"?<section className="journal-record-workspace"><header className="journal-record-feed-header"><div><h1>{journalRecordFilters[view.recordFilter||"all"]}</h1><select aria-label="速记范围" value={view.recordFilter==="pinned"?"pinned":"all"} onChange={event=>store.update({recordFilter:event.target.value as "all"|"pinned"})}><option value="all">全部</option><option value="pinned">置顶</option></select><span>{feed.length} 条</span></div><label><Search size={17}/><input ref={recordSearch} aria-label="搜索记录" placeholder="搜索记录…  Ctrl K" value={query} onChange={event=>setQuery(event.target.value)}/></label><button onClick={()=>createRecord(store.anchor||today)}><Plus size={16}/>新建</button></header><details className="journal-storage-settings"><summary>保存位置与同步设置</summary><QuickJournal mode="settings" libraries={libraries} scope={scope} view={view} dataVersion={dataVersion}/></details><div className="journal-record-feed">{feed.map(item=>item.node)}</div>{!feed.length&&!page.loading&&!records.loading&&<p className="journal-db-status">没有符合筛选的记录，可以调整日期或资料库。</p>}</section>:view.layout==="stream"?<JournalDailyStream store={store} today={today} scope={scope} dataVersion={dataVersion} selectedKey={selected} canCreate={true} onChoose={choose} onPreview={result=>{setPickedKey(result.entityKey);onPreview(result);}} onCreate={createRecord} onOpen={onOpen}/>:!page.error&&(view.layout==="calendar"?calendar():view.layout==="list"?list():table())}
      {!page.loading&&!page.error&&page.total===0&&visibleQuick.length===0&&view.layout!=="stream"&&view.layout!=="records"&&view.layout!=="calendar"&&<div className="journal-db-status"><CalendarDays size={24}/><strong>{filtered?"没有符合筛选的日志":"当前范围暂无日志"}</strong><p>可以调整日期范围或资料库。</p></div>}
      {view.layout!=="stream"&&!page.loading&&page.items.length<page.total&&<div className="journal-db-status"><button onClick={page.loadMore}>继续加载（已显示 {page.items.length} / {page.total} 篇）</button></div>}
    </div>
  </div>;
}
