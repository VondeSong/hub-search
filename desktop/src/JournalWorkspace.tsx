import { runtimeCapabilities } from "./RuntimePlatform";
import { CalendarDays, ExternalLink, Plus, Star, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { journalEntryTitle } from "./JournalPresentation";
import { pageFavoriteKey } from "./PageFavorites";
import { cleanSearchSnippet } from "./ResultExcerpt";
import { journalDateKey, journalDateLabel } from "./SearchWorkspacePresentation";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import { journalMonthDays, localJournalDate, useJournalViews } from "./JournalViews";
import { useJournalPage } from "./useJournalPage";
import { QuickJournal, QuickJournalCard } from "./QuickJournal";
import { JournalDailyStream } from "./JournalDailyStream";
import { JournalToolbar } from "./JournalToolbar";
import { JournalCapturePanel } from "./JournalCapturePanel";
import { JournalRecordCard } from "./JournalRecordCard";
import { journalHeatLevel,journalRecordMatches,journalDocumentKey,journalIndexInView,useJournalRecords } from "./JournalRecords";
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
  const [taskCount,setTaskCount]=useState(0);
  const createRecord=(date:string)=>setCaptureDay(date);
  const view=runtimeCapabilities.mobile?{...store.view,layout:"records" as const,recordFilter:"all" as const,period:store.view.period==="month"?"all" as const:store.view.period,ascending:false}:store.view;const today=localJournalDate();
  const page=useJournalPage(view,scope,dataVersion,view.layout!=="stream");
  const root=useRef<HTMLDivElement>(null),body=useRef<HTMLDivElement>(null);
  const [chosenDay,setChosenDay]=useState(""),[pickedKey,setPickedKey]=useState("");
  const [expandedDays,setExpandedDays]=useState<Set<string>>(new Set());
  const previousNavigation=useRef(selectedDate),sessionPosition=useRef(new Map<string,number>());
  const sessionKey=`${view.layout}:${view.month}:${view.period}:${view.day}:${view.query}:${JSON.stringify(view.libraries)}`;
  const previousSession=useRef(sessionKey),consumedAnchor=useRef("");
  useEffect(()=>{if(previousNavigation.current!==selectedDate){previousNavigation.current=selectedDate;if(selectedDate){store.navigate(selectedDate.length===7?`${selectedDate}-01`:selectedDate);if(view.layout==="calendar")setChosenDay(selectedDate.length===10?selectedDate:"");}}},[selectedDate]);
  useEffect(()=>{setChosenDay(view.layout==="calendar"&&selectedDate===store.anchor&&store.anchor.length===10?store.anchor:"");},[view.month,store.activeId]);
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
  const matchingIndex=records.index.filter(item=>!item.representedByQuick&&item.matchesQuery!==false&&journalIndexInView(item,view,scope)&&journalRecordMatches(item,view.recordFilter||"all",records.pins));
  const months=[...new Set(matchingIndex.map(item=>item.date.slice(0,7)))].sort();
  const filtered=(view.recordFilter&&view.recordFilter!=="all")||!!view.query||view.libraries!==null||view.period==="day";
  if(runtimeCapabilities.mobile)return <div ref={root} className="results-pane journal-database journal-mobile">
    <div ref={body} className="journal-db-body" onScroll={event=>sessionPosition.current.set(sessionKey,event.currentTarget.scrollTop)}>
      <QuickJournal mode="feed" onViewChange={store.update} libraries={libraries} scope={scope} view={view} dataVersion={dataVersion}/>
    </div>
  </div>;
  return <div ref={root} className={`results-pane journal-database ${view.layout==="stream"?"is-daily":view.layout==="records"?"is-memo":""} ${view.compact?"is-compact":""}`}>
    <JournalToolbar store={store} libraries={view.layout==="stream"?taskLibraries:supported} onUpdate={store.update} taskCount={view.layout==="stream"?taskCount:0} resultCount={matchingIndex.length} loading={records.loading} error={!!records.error} onCreate={()=>createRecord(chosenDay||store.anchor||today)}/>
    {records.error&&<div className="journal-db-status" role="alert">{records.error}<button onClick={records.refresh}>重试记录</button></div>}{view.layout!=="stream"&&page.error&&<div className="journal-db-status" role="alert">{page.error}<button onClick={page.retry}>重试</button></div>}
    <JournalCapturePanel libraries={libraries} day={captureDay} onDay={setCaptureDay} dataVersion={dataVersion} scope={scope} view={view}/><div ref={body} className="journal-db-body" aria-busy={view.layout!=="stream"&&view.layout!=="records"&&page.loading} onScroll={event=>sessionPosition.current.set(sessionKey,event.currentTarget.scrollTop)}>
      {view.layout==="calendar"&&view.period==="all"&&<nav className="journal-result-months" aria-label="匹配记录的月份"><span>匹配月份</span>{months.map(month=><button key={month} aria-pressed={view.month===month} onClick={()=>store.update({month})}>{month}<small>{matchingIndex.filter(item=>item.date.startsWith(month)).length}</small></button>)}</nav>}
      {view.layout==="records"?<section className="journal-record-workspace"><details className="journal-storage-settings"><summary>保存位置与同步设置</summary><QuickJournal mode="settings" libraries={libraries} scope={scope} view={view} dataVersion={dataVersion}/></details><div className="journal-record-feed">{feed.map(item=>item.node)}</div>{!feed.length&&!page.loading&&!records.loading&&<p className="journal-db-status">没有符合筛选的记录，可以调整日期或资料库。</p>}</section>:view.layout==="stream"?<JournalDailyStream onTaskCount={setTaskCount} store={store} today={today} scope={scope} dataVersion={dataVersion} selectedKey={selected} canCreate={true} onChoose={choose} onPreview={result=>{setPickedKey(result.entityKey);onPreview(result);}} onCreate={createRecord} onOpen={onOpen}/>:!page.error&&(view.layout==="calendar"?calendar():view.layout==="list"?list():table())}
      {!page.loading&&!page.error&&page.total===0&&visibleQuick.length===0&&view.layout!=="stream"&&view.layout!=="records"&&view.layout!=="calendar"&&<div className="journal-db-status"><CalendarDays size={24}/><strong>{filtered?"没有符合筛选的日志":"当前范围暂无日志"}</strong><p>可以调整日期范围或资料库。</p></div>}
      {view.layout!=="stream"&&!page.loading&&page.items.length<page.total&&<div className="journal-db-status"><button onClick={page.loadMore}>继续加载（已显示 {page.items.length} / {page.total} 篇）</button></div>}
    </div>
  </div>;
}
