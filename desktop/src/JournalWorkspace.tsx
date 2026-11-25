import { runtimeCapabilities } from "./RuntimePlatform";
import { CalendarDays, ExternalLink, Image, Plus, Sparkles, Star, X } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AgentPanelContext, AgentTextMaterialContext } from "./StandaloneAgentLauncher";
import { userProfileStorage } from "./UserProfileStorage";
import { journalEntryTitle } from "./JournalPresentation";
import { pageFavoriteKey } from "./PageFavorites";
import { cleanSearchSnippet } from "./ResultExcerpt";
import { journalDateKey, journalDateLabel } from "./SearchWorkspacePresentation";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import { journalMonthDays, localJournalDate, shiftJournalDay, useJournalViews } from "./JournalViews";
import { useJournalPage } from "./useJournalPage";
import { QuickJournal, QuickJournalCard } from "./QuickJournal";
import { JournalDailyStream } from "./JournalDailyStream";
import { groupJournalDailyTasks, useJournalDailyData } from "./JournalDailyData";
import { useUnifiedTasks } from "./UnifiedTaskData";
import { JournalToolbar } from "./JournalToolbar";
import { JournalCapturePanel } from "./JournalCapturePanel";
import { JournalRecordCard } from "./JournalRecordCard";
import { JournalNavigation } from "./JournalNavigation";
import { WorkspaceHeaderContext } from "./WorkspaceChrome";
import { journalHeatLevel,journalRecordMatches,journalDocumentKey,journalIndexInView,useJournalRecords } from "./JournalRecords";
import "./JournalDatabase.css";
import "./JournalCalendarAlignment.css";
import "./JournalDesktop.css";

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
  const navigation = useContext(WorkspaceHeaderContext)?.journalNavigation;
  const [navigationExpanded, setNavigationExpanded] = useState(true);
  const assistantPanel=useContext(AgentPanelContext);
  const textMaterial=useContext(AgentTextMaterialContext);
  const [serifReading,setSerifReading]=useState(()=>{try{return userProfileStorage.getItem("hub.journal.serif.v1")==="true";}catch{return false;}});
  const toggleSerifReading=useCallback(()=>{
    setSerifReading(current=>{
      const next=!current;
      try{userProfileStorage.setItem("hub.journal.serif.v1",String(next));}catch{/* ignore */}
      return next;
    });
  },[]);
  const [capture, setCapture] = useState<{ day: string; inline: boolean } | null>(null);
  const [taskCount,setTaskCount]=useState(0);
  const createRecord = useCallback((day: string) => setCapture(day ? { day, inline: false } : null), []);
  const view=runtimeCapabilities.mobile?{...store.view,layout:"records" as const,recordFilter:"all" as const,period:store.view.period==="month"?"all" as const:store.view.period,ascending:false}:store.view;const today=localJournalDate();
  const page=useJournalPage(view,scope,dataVersion,view.layout!=="stream");
  const monthDays = journalMonthDays(view.month);
  const calendarTaskScope = (view.recordFilter||"all")!=="all" ? [] : scope === null ? view.libraries : view.libraries === null ? scope : scope.filter(id=>view.libraries?.includes(id));
  const calendarTasks = useJournalDailyData({from:monthDays[0],to:shiftJournalDay(monthDays[monthDays.length-1],1),scope:calendarTaskScope,query:view.query,enabled:Boolean(navigation)&&view.layout==="calendar",dataVersion});
  const sharedTasks = useUnifiedTasks({enabled:false});
  const root=useRef<HTMLDivElement>(null),body=useRef<HTMLDivElement>(null);
  const [chosenDay,setChosenDay]=useState(""),[pickedKey,setPickedKey]=useState("");
  const timeline = view.layout === "stream" && !runtimeCapabilities.mobile;
  const capturePlacement = capture ? (timeline && capture.inline ? "day" : "floating") : timeline ? "top" : "floating";
  const captureDay = capture?.day ?? (timeline ? (view.period === "day" ? view.day : today) : "");
  const writeJournal = () => {
    const day = chosenDay || store.anchor || captureDay || today;
    const input = capturePlacement === "top" && captureDay === day ? root.current?.querySelector<HTMLElement>(".journal-inline-editor-top textarea:not([disabled]), .journal-inline-editor-top [contenteditable=true]") : null;
    if (input) input.focus();
    else createRecord(day);
  };
  const [expandedDays,setExpandedDays]=useState<Set<string>>(new Set());
  const previousNavigation=useRef(selectedDate),sessionPosition=useRef(new Map<string,number>());
  const sessionKey=`${view.layout}:${view.month}:${view.period}:${view.day}:${view.query}:${JSON.stringify(view.libraries)}`;
  const previousSession=useRef(sessionKey),consumedAnchor=useRef("");
  useEffect(()=>{if(previousNavigation.current!==selectedDate){previousNavigation.current=selectedDate;if(selectedDate){if(!navigation)store.navigate(selectedDate.length===7?`${selectedDate}-01`:selectedDate);if(view.layout==="calendar")setChosenDay(selectedDate.length===10?selectedDate:"");}}},[selectedDate,navigation]);
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
  const openTimelineDay = (date: string) => store.update({layout:"stream",period:"day",day:date,month:date.slice(0,7)});
  const desktopCalendar = () => {
    const dates = journalMonthDays(view.month, true);
    const byDate = new Map<string, typeof visibleQuick>();
    for (const item of visibleQuick) byDate.set(item.record.date, [...(byDate.get(item.record.date) || []), item]);
    const days = monthDays.map(date => {
      const tasks = calendarTasks.tasksByDate.get(date);
      return {date, documents:grouped.get(date) || [], quick:byDate.get(date) || [], completed:tasks?.completed.length ?? 0, pending:(tasks?.created.length ?? 0)+(tasks?.scheduled.length ?? 0)};
    });
    const activeDays = days.filter(day=>day.documents.length||day.quick.length||day.completed||day.pending);
    const completed = days.reduce((sum,day)=>sum+day.completed,0);
    const pending = days.reduce((sum,day)=>sum+day.pending,0);
    const logs = days.reduce((sum,day)=>sum+day.documents.length+day.quick.length,0);
    return <section className="journal-desktop-month" aria-label="月历视图">
      <header><h2>{view.month.slice(0,4)} 年 {Number(view.month.slice(5))} 月</h2><small>{activeDays.length} 天有记录 · {logs} 条日志 · {completed}/{completed+pending} 任务完成</small><button type="button" onClick={()=>openTimelineDay(today)}>跳至今天（{Number(today.slice(5,7))}/{Number(today.slice(8))}）</button></header>
      <div className="journal-desktop-month-grid">
        {["周日","周一","周二","周三","周四","周五","周六"].map(day=><span className="journal-desktop-month-weekday" key={day}>{day}</span>)}
        {dates.map(date=>{
          const day = date.startsWith(view.month+"-") ? days[Number(date.slice(8))-1] : null;
          if (!day) return <div className="journal-desktop-month-cell outside" key={date}/>;
          const entries = [
            ...day.documents.map(entry=>({id:entry.entityKey,title:journalEntryTitle(entry),attachments:0,pending:false})),
            ...day.quick.map(item=>({id:item.record.id,title:item.body.split("\n").find(line=>line.trim())?.replace(/^#{1,6}\s+/,"")||"附件记录",attachments:item.record.attachments.length,pending:!item.applied})),
          ];
          return <div className={`journal-desktop-month-cell${date===today?" today":""}`} key={date}>
            <button type="button" className="journal-month-open-day" aria-label={`${journalDateLabel(date)}，${entries.length}条记录，${day.pending}项待办，${day.completed}项已完成`} onClick={()=>openTimelineDay(date)}>
              <span className="journal-month-topline"><strong>{Number(date.slice(8))}</strong>{day.completed+day.pending>0&&<small className={day.pending===0?"done":""}>✓ {day.completed}/{day.completed+day.pending}</small>}</span>
              {entries.slice(0,2).map(entry=><span className={`journal-month-note${entry.pending?" pending":""}`} key={entry.id}><span>{entry.title}</span>{entry.attachments>0&&<small><Image size={10}/>{entry.attachments} 个附件</small>}</span>)}
              {entries.length>2&&<small>+{entries.length-2} 条</small>}
            </button>
            <button type="button" className="journal-month-add" aria-label={`补记 ${date}`} onClick={()=>createRecord(date)}><Plus size={13}/></button>
          </div>;
        })}
      </div>
    </section>;
  };
  const calendar=()=>{
    const dates=journalMonthDays(view.month,true);
    return <><div className="journal-db-calendar"><div className="journal-month-week">{["日","一","二","三","四","五","六"].map(d=><span key={d}>{d}</span>)}</div><div className="journal-month-grid">{dates.map(date=>{const entries=grouped.get(date)||[];return <section data-heat={journalHeatLevel(records.index.length?records.index.filter(item=>!item.representedByQuick&&item.date===date).length:entries.length+visibleQuick.filter(i=>i.record.date===date).length)} className={`journal-month-cell ${date.slice(0,7)!==view.month?"outside-month":""} ${date===today?"today":""} ${chosenDay===date?"selected":""}`} key={date}><button className="journal-month-date" onClick={()=>{setChosenDay(date);}} aria-label={`${journalDateLabel(date)}，${entries.length+visibleQuick.filter(item=>item.record.date===date).length}条记录`} aria-pressed={chosenDay===date}>{Number(date.slice(8))}{date===today&&<span>今天</span>}</button><span className="journal-month-count">{entries.length+visibleQuick.filter(item=>item.record.date===date).length||""}</span>{entries.slice(0,3).map(result=><button key={result.entityKey} className={`journal-month-entry ${selected===result.entityKey?"is-selected":""}`} disabled={page.loading} onClick={()=>preview(result)} title={`${result.libraryName} · ${journalEntryTitle(result)}`}>{view.source&&<small>{result.libraryName}</small>}<span>{journalEntryTitle(result)}</span></button>)}{visibleQuick.filter(item=>item.record.date===date).slice(0,3).map(item=><button className="journal-month-entry" key={item.record.id} onClick={()=>setChosenDay(date)}><span>{item.body.split("\n")[0]||"附件记录"}</span></button>)}{entries.length>3&&<button onClick={()=>setChosenDay(date)}>还有 {entries.length-3} 篇</button>}</section>;})}</div></div>{chosenDay&&<section className="journal-day-agenda"><header><strong>{journalDateLabel(chosenDay)}</strong><button aria-label="关闭当天日志" onClick={()=>setChosenDay("")}><X size={16}/></button></header>{cards(chosenDay,grouped.get(chosenDay)||[],Number.MAX_SAFE_INTEGER)}{quickCards(chosenDay)}{!grouped.get(chosenDay)?.length&&!visibleQuick.some(item=>item.record.date===chosenDay)&&emptyDay(chosenDay)}<button onClick={()=>{store.update({period:"day",day:chosenDay,layout:"list"});}}>仅看这一天</button></section>}</>;
  };
  const list=()=>{
    const allDays=new Map(grouped);for(const item of visibleQuick)if(!allDays.has(item.record.date))allDays.set(item.record.date,[]);const groups=[...allDays.entries()];groups.sort(([a],[b])=>view.ascending?a.localeCompare(b):b.localeCompare(a));
    return <div className="journal-db-list">{groups.map(([date,entries])=><section className="journal-list-day" key={date} data-journal-day={date}><header><button onClick={()=>choose(date)}>{journalDateLabel(date)}</button><small>{entries.length} 篇日志</small></header>{entries.map(result=><div className={`journal-list-row ${selected===result.entityKey?"is-selected":""}`} key={result.entityKey}><button disabled={page.loading} title={journalEntryTitle(result)} aria-label={`预览 ${journalEntryTitle(result)} · ${result.libraryName}`} aria-pressed={selected===result.entityKey} onClick={()=>preview(result)}>{renderIcon(result,result.libraryName)}<span><strong>{journalEntryTitle(result)}</strong>{view.summary&&entrySummary(result)!==journalEntryTitle(result)&&<small>{entrySummary(result)||"暂无摘要"}</small>}</span>{view.source&&<em>{result.libraryName}</em>}</button><button onClick={()=>onOpen(result)} aria-label={`在来源中打开 ${journalEntryTitle(result)}`}><ExternalLink size={14}/></button></div>)}{quickCards(date)}</section>)}</div>;
  };
  const desktopList = () => {
    const rows = [
      ...[...grouped.entries()].flatMap(([date,entries])=>entries.map(entry=>({date,id:entry.entityKey,title:journalEntryTitle(entry),text:entrySummary(entry),status:"来源",entry}))),
      ...visibleQuick.map(item=>({date:item.record.date,id:item.record.id,title:item.body.split("\n").find(line=>line.trim())?.replace(/^#{1,6}\s+/,"")||"附件记录",text:item.body,status:item.applied?"已写入 OS":"待写入 OS",item})),
    ].sort((a,b)=>view.ascending?a.date.localeCompare(b.date):b.date.localeCompare(a.date));
    return <section className="journal-desktop-list" aria-label="紧凑列表">{rows.map(row=>{
      const content = <><time>{row.date}</time><span><strong>{row.title}</strong>{row.text&&row.text!==row.title&&<small>{row.text}</small>}</span><em>{row.status}</em></>;
      return <div key={row.id} className="journal-desktop-list-row">
        {"entry" in row ? <button type="button" className="journal-desktop-list-detail" onClick={()=>preview(row.entry)}>{content}</button> : <details><summary className="journal-desktop-list-detail">{content}</summary><QuickJournalCard item={row.item} timeline mobile={false} onPreview={onPreview} onTag={tag=>store.update({query:"#"+tag})}/></details>}
        {assistantPanel&&textMaterial&&row.text&&<button className="journal-list-ask" type="button" aria-label={`挂载 ${row.title} 给助手`} onClick={()=>{textMaterial.setPending({kind:"text",title:row.title,text:row.text.slice(0,2450)});assistantPanel(null);}}><Sparkles size={13}/></button>}
      </div>;
    })}{!rows.length&&!page.loading&&!records.loading&&<p className="journal-db-status">暂无匹配日志</p>}</section>;
  };
  const table=()=> <div className="journal-db-table-wrap"><table aria-label="日志表格"><thead><tr><th>标题</th><th><button onClick={()=>store.update({sort:"date",ascending:view.sort==="date"?!view.ascending:true})}>日志日期 {view.sort==="date"?(view.ascending?"↑":"↓"):""}</button></th>{view.source&&<th>资料库</th>}{view.summary&&<th>摘要</th>}{view.modified&&<th><button onClick={()=>store.update({sort:"modified",ascending:view.sort==="modified"?!view.ascending:false})}>更新时间 {view.sort==="modified"?(view.ascending?"↑":"↓"):""}</button></th>}<th><span className="sr-only">操作</span></th></tr></thead><tbody>{page.items.map(result=><tr key={result.entityKey} className={selected===result.entityKey?"is-selected":""}><td><button className="journal-table-title" disabled={page.loading} onClick={()=>preview(result)}>{renderIcon(result,result.libraryName)}{journalEntryTitle(result)}</button></td><td>{journalDateKey(result)}</td>{view.source&&<td>{result.libraryName}</td>}{view.summary&&<td>{entrySummary(result)||"暂无摘要"}</td>}{view.modified&&<td>{modifiedLabel(result)}</td>}<td><button onClick={()=>onOpen(result)} aria-label={`在来源中打开 ${journalEntryTitle(result)}`}><ExternalLink size={14}/></button></td></tr>)}</tbody></table></div>;
  const matchingIndex=records.index.filter(item=>!item.representedByQuick&&item.matchesQuery!==false&&journalIndexInView(item,view,scope)&&journalRecordMatches(item,view.recordFilter||"all",records.pins));
  const months=[...new Set(matchingIndex.map(item=>item.date.slice(0,7)))].sort();
  const filtered=(view.recordFilter&&view.recordFilter!=="all")||!!view.query||view.libraries!==null||view.period==="day";
  const handleAiDailySummary=useCallback((overrideDay?:string)=>{
    if(!assistantPanel||!textMaterial)return;
    const targetDay=overrideDay||chosenDay||(view.period==="day"&&view.day)||(store.anchor.length===10?store.anchor:today);
    const dayDocs=grouped.get(targetDay)||records.index.filter(item=>!item.representedByQuick&&item.date===targetDay&&item.preview).map(item=>item.preview!);
    const dayQuick=records.items.filter(item=>item.record.date===targetDay);
    const sections:string[]=[];
    for(const doc of dayDocs){
      const snippet=entrySummary(doc);
      sections.push(`- [${doc.libraryName}] ${journalEntryTitle(doc)}${snippet?`：${snippet}`:""}`);
    }
    for(const memo of dayQuick){
      if(memo.body.trim())sections.push(`- [速记] ${memo.body.trim()}`);
    }
    const completed = groupJournalDailyTasks(sharedTasks.dashboard.tasks, {from:targetDay,to:shiftJournalDay(targetDay,1),scope,query:""}).get(targetDay)?.completed ?? [];
    for (const {task} of completed) sections.push(`- [已完成任务 · ${task.collectionName || task.libraryName}] ${task.title}`);
    const rawSummaryText = sections.length > 0
      ? `以下是 ${targetDay} 的日志、速记与已完成任务（共 ${sections.length} 条），请据此归纳进展、待跟进事项并起草简短复盘：\n\n${sections.join("\n")}`
      : `${targetDay} 当前尚无已归档日志，请协助围绕今日已完成工作与明日重点起草一份简短复盘。`;
    const safeSummaryText = rawSummaryText.length <= 2450
      ? rawSummaryText
      : `${rawSummaryText.slice(0, 2430)}…（已按助手字数上限节选）`;
    textMaterial.setPending({
      kind:"text",
      title:`${targetDay} 日志日结材料`,
      text:safeSummaryText,
    });
    assistantPanel(null);
  },[assistantPanel,chosenDay,grouped,records.index,records.items,scope,sharedTasks.dashboard.tasks,store.anchor,textMaterial,today,view.day,view.period]);
  if(runtimeCapabilities.mobile)return <div ref={root} className="results-pane journal-database journal-mobile">
    <div ref={body} className="journal-db-body" onScroll={event=>sessionPosition.current.set(sessionKey,event.currentTarget.scrollTop)}>
      <QuickJournal mode="feed" onViewChange={store.update} libraries={libraries} scope={scope} view={view} dataVersion={dataVersion}/>
    </div>
  </div>;
  const stage = <div ref={root} className={`results-pane journal-database ${view.layout==="stream"?"is-daily":view.layout==="records"?"is-memo":""} ${view.compact?"is-compact":""} ${serifReading?"is-serif-reading":""}`}>
    <JournalToolbar store={store} libraries={view.layout==="stream"?taskLibraries:supported} onUpdate={store.update} taskCount={view.layout==="stream"?taskCount:0} resultCount={matchingIndex.length} serifReading={serifReading} onToggleSerifReading={toggleSerifReading} onAiDailySummary={assistantPanel&&textMaterial?()=>handleAiDailySummary():undefined} loading={records.loading} error={!!records.error} onCreate={writeJournal}
      navigationExpanded={navigation ? navigationExpanded : undefined} onToggleNavigation={navigation ? () => setNavigationExpanded(open => !open) : undefined}/>
    {filtered&&<div className="journal-filter-hit-strip" role="status"><span>结果命中流（已隐藏空白日）· 命中 {matchingIndex.length} 条日志{view.period==="day"&&view.day?` · 日期 ${view.day}`:""}</span><button type="button" onClick={()=>store.update({query:"",recordFilter:"all",libraries:null,period:"month",day:""})}>重置筛选</button></div>}
    {records.error&&<div className="journal-db-status" role="alert">{records.error}<button onClick={records.refresh}>重试记录</button></div>}{view.layout!=="stream"&&page.error&&<div className="journal-db-status" role="alert">{page.error}<button onClick={page.retry}>重试</button></div>}
    <JournalCapturePanel libraries={libraries} day={captureDay} placement={capturePlacement} onDay={createRecord} dataVersion={dataVersion} scope={scope} view={view} desktop={Boolean(navigation)} topDay={navigation&&timeline&&capture?.day!==today ? today : undefined}>
    {(editor, topEditor) => <div ref={body} className="journal-db-body" aria-busy={view.layout!=="stream"&&view.layout!=="records"&&page.loading} onScroll={event=>sessionPosition.current.set(sessionKey,event.currentTarget.scrollTop)}>
      {view.layout==="calendar"&&view.period==="all"&&<nav className="journal-result-months" aria-label="匹配记录的月份"><span>匹配月份</span>{months.map(month=><button key={month} aria-pressed={view.month===month} onClick={()=>store.update({month})}>{month}<small>{matchingIndex.filter(item=>item.date.startsWith(month)).length}</small></button>)}</nav>}
      {view.layout==="records"?<section className="journal-record-workspace"><details className="journal-storage-settings"><summary>保存位置与同步设置</summary><QuickJournal mode="settings" libraries={libraries} scope={scope} view={view} dataVersion={dataVersion}/></details><div className="journal-record-feed">{feed.map(item=>item.node)}</div>{!feed.length&&!page.loading&&!records.loading&&<p className="journal-db-status">没有符合筛选的记录，可以调整日期或资料库。</p>}</section>:view.layout==="stream"?<JournalDailyStream desktop={Boolean(navigation)} onTaskCount={setTaskCount} store={store} today={today} scope={scope} dataVersion={dataVersion} selectedKey={selected} canCreate={true} onChoose={choose} onPreview={result=>{setPickedKey(result.entityKey);onPreview(result);}} onCreate={day => setCapture(current => current?.inline && current.day === day ? null : { day, inline: true })} composer={editor} topComposer={topEditor} composerDate={capturePlacement === "day" ? captureDay : undefined} onReviewDay={assistantPanel&&textMaterial?(date)=>handleAiDailySummary(date):undefined} onOpen={onOpen}/>:!page.error&&(view.layout==="calendar"?(navigation?desktopCalendar():calendar()):view.layout==="list"?(navigation?desktopList():list()):table())}
      {!page.loading&&!page.error&&page.total===0&&visibleQuick.length===0&&(view.layout==="table"||view.layout==="list"&&!navigation)&&<div className="journal-db-status"><CalendarDays size={24}/><strong>{filtered?"没有符合筛选的日志":"当前范围暂无日志"}</strong><p>可以调整日期范围或资料库。</p></div>}
      {view.layout!=="stream"&&!page.loading&&page.items.length<page.total&&<div className="journal-db-status"><button onClick={page.loadMore}>继续加载（已显示 {page.items.length} / {page.total} 篇）</button></div>}
    </div>}
    </JournalCapturePanel>
  </div>;
  if (!navigation) return stage;
  return <div className="journal-desktop">
    <aside className="journal-desktop-navigation" id="journal-desktop-navigation" aria-label="日志导航" hidden={!navigationExpanded}>
      <JournalNavigation dates={navigation.dates} selectedDate={selectedDate} onSelectDate={navigation.onSelectDate} desktop scope={scope}/>
    </aside>
    {stage}
  </div>;
}
