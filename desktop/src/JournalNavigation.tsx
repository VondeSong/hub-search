import { CalendarDays, CalendarRange, History, Image, List, Pin, Paperclip, Tag, Tags } from "lucide-react";
import { useMemo } from "react";
import { JournalNavigator } from "./JournalNavigator";
import { journalEntryTitle } from "./JournalPresentation";
import { localJournalDate, shiftJournalDay, useJournalViews } from "./JournalViews";
import { cleanSearchSnippet } from "./ResultExcerpt";
import {journalRecordFilters,journalRecordMatches,journalIndexInView,useJournalRecords,type JournalRecordFilter} from "./JournalRecords";

export function JournalNavigation({dates,selectedDate,onSelectDate,desktop=false,scope=null}:{dates:Array<{date:string;sources:number;count?:number}>;selectedDate:string;onSelectDate:(date:string)=>void;desktop?:boolean;scope?:string[]|null}){
  const store=useJournalViews();const records=useJournalRecords();
  const filterCounts=Object.fromEntries((["all","pinned","attachments","untagged"] as const).map(key=>[key,records.index.filter(item=>!item.representedByQuick&&item.matchesQuery!==false&&(!store||journalIndexInView(item,store.view,scope))&&journalRecordMatches(item,key,records.pins)).length])) as Record<JournalRecordFilter,number>;
  const onFilter=(filter:JournalRecordFilter)=>{store?.update({recordFilter:store.view.recordFilter===filter?"all":filter});};
  const heatDates=new Map<string,{date:string;sources:number;count:number}>(),dayLibraries=new Map<string,Set<string>>();
  for(const item of records.index){if(item.representedByQuick||desktop&&store&&!journalIndexInView(item,store.view,scope,false))continue;const day=heatDates.get(item.date)||{date:item.date,sources:0,count:0};day.count++;const sources=dayLibraries.get(item.date)||new Set<string>();sources.add(item.libraryId);dayLibraries.set(item.date,sources);day.sources=sources.size;heatDates.set(item.date,day);}
  const activity=records.index.length?[...heatDates.values()]:dates.map(day=>({...day,count:day.count??0}));
  const anchorDay=selectedDate.length===10?selectedDate:localJournalDate();
  const historicalReview=useMemo(()=>{
    if(anchorDay.length!==10)return null;
    const monthDay=anchorDay.slice(5);
    const year=anchorDay.slice(0,4);
    const monthAgo=shiftJournalDay(anchorDay,-30);
    const weekAgo=shiftJournalDay(anchorDay,-7);
    const quickByDate=new Map<string,string>();
    for(const q of records.items){if(q.record.date&&!quickByDate.has(q.record.date))quickByDate.set(q.record.date,q.body.trim());}

    const buildHit=(date:string,tag:string)=>{
      const indexed=records.index.find(item=>!item.representedByQuick&&item.date===date&&item.preview);
      if(indexed?.preview){
        const title=journalEntryTitle(indexed.preview);
        const snippet=cleanSearchSnippet(indexed.preview.snippet).replace(/^\d{4}[-.]\d{2}[-.]\d{2}\s*/,"").trim();
        return {date,tag,title,excerpt:snippet&&snippet!==title?snippet:indexed.preview.libraryName};
      }
      const quickText=quickByDate.get(date);
      if(quickText){
        const lines=quickText.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
        return {date,tag,title:lines[0]||`${date} 速记`,excerpt:lines[1]||"点击回看当日速记"};
      }
      if(activity.some(d=>d.date===date&&(d.count??0)>0)){
        return {date,tag,title:`${date} 日志记录`,excerpt:"点击回看当日归档内容"};
      }
      return null;
    };

    const priorSameDay=[...new Set([...records.index.map(i=>i.date),...activity.map(a=>a.date)])]
      .filter(d=>d.length===10&&d.slice(5)===monthDay&&d.slice(0,4)<year)
      .sort((a,b)=>b.localeCompare(a))[0];
    if(priorSameDay){
      const hit=buildHit(priorSameDay,"往年同日");
      if(hit)return hit;
    }
    return buildHit(monthAgo,"30 天前")??buildHit(weekAgo,"7 天前");
  },[activity,anchorDay,records.index,records.items]);
  const icons={all:CalendarDays,pinned:Pin,attachments:desktop?Image:Paperclip,untagged:desktop?Tag:Tags};
  const pendingQuickCount=records.items.filter(item=>!item.applied||Boolean(item.sourceError)).length;
  const archivedQuickCount=records.items.length-pendingQuickCount;
  if(!store)return <JournalNavigator availableDates={activity} selectedDate={selectedDate} onSelectDate={onSelectDate}/>;
  const taskScope = scope === null ? store.view.libraries : store.view.libraries === null ? scope : scope.filter(id => store.view.libraries?.includes(id));
  const selectDesktopDate = (date: string, action?: "today") => {
    const month = date.slice(0, 7);
    const single = date.length === 10 && (action === "today" || store.view.period !== "day" || store.view.day !== date);
    store.update({ period: single ? "day" : "month", month, day: single ? date : "" });
    onSelectDate(single ? date : "");
  };
  const content = <>
    {!desktop&&<nav aria-label="日志快捷入口"><button onClick={()=>{store.reset();store.update({period:"all",layout:"list",ascending:false});onSelectDate("");}}><List size={16}/>全部日志</button><button onClick={()=>{store.update({layout:"stream",period:"month",recordFilter:"all",query:""});store.navigate(localJournalDate());onSelectDate(localJournalDate());}}><CalendarDays size={16}/>今天</button><button onClick={()=>{store.reset();onSelectDate(localJournalDate());}}><CalendarRange size={16}/>本月记录</button></nav>}
    <div className="journal-nav-heading"><span>日志筛选</span></div>
    <nav className="journal-nav-filters" aria-label="日志常用筛选">
      {(["all", "pinned", "attachments", "untagged"] as const).map(key => {
        const Icon = icons[key];
        const active = (store.view.recordFilter || "all") === key;
        return <button key={key} aria-pressed={active} onClick={()=>key==="all"?store.update({recordFilter:"all"}):onFilter(key)}>
          <span className={`journal-nav-icon-badge ${key}${active?" active":""}`} aria-hidden="true"><Icon size={12}/></span>
          <span>{key==="all"?"全部日志":desktop&&key==="pinned"?"已置顶":journalRecordFilters[key]}</span><small>{filterCounts[key]}</small>
        </button>;
      })}
    </nav>
    {!desktop&&<p className="journal-nav-hint">跨日期查找记录</p>}
    <div className="journal-nav-calendar"><JournalNavigator availableDates={activity} desktop={desktop} taskScope={taskScope} selectedDate={desktop ? store.view.day || store.view.month : store.anchor||store.view.day||(store.view.month===localJournalDate().slice(0,7)?localJournalDate():`${store.view.month}-01`)} onSelectDate={desktop ? selectDesktopDate : date=>{if(!date){store.update({period:"all",layout:"list"});}else{if(date.length===7)store.update({period:"month",month:date});store.navigate(date.length===7?`${date}-01`:date);}onSelectDate(date);}}/></div>
    <section className="journal-history-section" aria-label="历史回看">
      <div className="journal-nav-heading"><span>历史回看</span><small>旧日对照</small></div>
      {historicalReview?(
        <button
          type="button"
          className="journal-history-review-card"
          onClick={()=>{
            if (desktop) { selectDesktopDate(historicalReview.date); return; }
            store.update({period:"day",day:historicalReview.date,month:historicalReview.date.slice(0,7)});
            store.navigate(historicalReview.date);
            onSelectDate(historicalReview.date);
          }}
        >
          <span className="journal-history-meta">
            <time dateTime={historicalReview.date}>{historicalReview.date}</time>
            <em>{historicalReview.tag} ↗</em>
          </span>
          <strong>{historicalReview.title}</strong>
          <small>{historicalReview.excerpt}</small>
        </button>
      ):(
        <div className="journal-history-empty"><History size={13} aria-hidden="true"/><span>尚无往年或上月同日记录</span></div>
      )}
    </section>
  </>;
  return <div className="journal-navigation">
    {desktop ? <div className="journal-desktop-nav-body">{content}</div> : content}
    <div className="journal-sidebar-sync-footer" title="本地速记与日志归档状态">
      <span>{desktop?`已归档 OS ${archivedQuickCount}`:`已归档 ${archivedQuickCount + records.index.length}`}{pendingQuickCount > 0 ? ` · 待写 ${pendingQuickCount}` : ""}</span>
      <i className={`journal-sidebar-sync-dot${pendingQuickCount > 0 ? " pending" : " active"}`} aria-hidden="true" />
    </div>
  </div>;
}
