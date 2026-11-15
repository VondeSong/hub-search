import { CalendarDays, CalendarRange, List, Pin, Paperclip, Tags } from "lucide-react";
import { JournalNavigator } from "./JournalNavigator";
import { localJournalDate, useJournalViews } from "./JournalViews";
import {journalRecordFilters,journalRecordMatches,journalIndexInView,useJournalRecords,type JournalRecordFilter} from "./JournalRecords";

export function JournalNavigation({dates,selectedDate,onSelectDate}:{dates:Array<{date:string;sources:number;count?:number}>;selectedDate:string;onSelectDate:(date:string)=>void}){
  const store=useJournalViews();const records=useJournalRecords();
  const filterCounts=Object.fromEntries((["all","pinned","attachments","untagged"] as const).map(key=>[key,records.index.filter(item=>!item.representedByQuick&&item.matchesQuery!==false&&(!store||journalIndexInView(item,store.view,null))&&journalRecordMatches(item,key,records.pins)).length])) as Record<JournalRecordFilter,number>;
  const onFilter=(filter:JournalRecordFilter)=>{store?.update({recordFilter:store.view.recordFilter===filter?"all":filter});};
  const heatDates=new Map<string,{date:string;sources:number;count:number}>(),dayLibraries=new Map<string,Set<string>>();
  for(const item of records.index){if(item.representedByQuick)continue;const day=heatDates.get(item.date)||{date:item.date,sources:0,count:0};day.count++;const sources=dayLibraries.get(item.date)||new Set<string>();sources.add(item.libraryId);dayLibraries.set(item.date,sources);day.sources=sources.size;heatDates.set(item.date,day);}
  const activity=records.index.length?[...heatDates.values()]:dates.map(day=>({...day,count:day.count??0}));
  const icons={pinned:Pin,attachments:Paperclip,untagged:Tags};
  if(!store)return <JournalNavigator availableDates={activity} selectedDate={selectedDate} onSelectDate={onSelectDate}/>;
  return <div className="journal-navigation">
    <nav aria-label="日志快捷入口"><button onClick={()=>{store.reset();store.update({period:"all",layout:"list",ascending:false});onSelectDate("");}}><List size={16}/>全部日志</button><button onClick={()=>{store.update({layout:"stream",period:"month",recordFilter:"all",query:""});store.navigate(localJournalDate());onSelectDate(localJournalDate());}}><CalendarDays size={16}/>今天</button><button onClick={()=>{store.reset();onSelectDate(localJournalDate());}}><CalendarRange size={16}/>本月记录</button></nav>
    <div className="journal-nav-heading"><span>常用筛选</span></div>
    <nav className="journal-nav-filters" aria-label="日志常用筛选">{(["pinned","attachments","untagged"] as const).map(key=>{const Icon=icons[key];return <button key={key} aria-pressed={store.view.recordFilter===key} onClick={()=>onFilter(key)}><Icon size={16}/><span>{journalRecordFilters[key]}</span><small>{filterCounts[key]}</small></button>;})}</nav>
    <p className="journal-nav-hint">跨日期查找记录</p>
    <div className="journal-nav-calendar"><JournalNavigator availableDates={activity} selectedDate={store.anchor||store.view.day||(store.view.month===localJournalDate().slice(0,7)?localJournalDate():`${store.view.month}-01`)} onSelectDate={date=>{if(!date){store.update({period:"all",layout:"list"});}else{if(date.length===7)store.update({period:"month",month:date});store.navigate(date.length===7?`${date}-01`:date);}onSelectDate(date);}}/></div>
  </div>;
}
