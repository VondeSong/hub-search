import { CalendarDays, CalendarRange, List, Pin, Paperclip, Tags } from "lucide-react";
import { JournalNavigator } from "./JournalNavigator";
import { localJournalDate, useJournalViews } from "./JournalViews";
import {journalRecordFilters,type JournalRecordFilter} from "../memo-data";

export function JournalNavigation({dates,selectedDate,onSelectDate,filterCounts,onFilter}:{dates:Array<{date:string;sources:number;count?:number}>;selectedDate:string;onSelectDate:(date:string)=>void;filterCounts:Record<JournalRecordFilter,number>;onFilter:(filter:JournalRecordFilter)=>void}){
  const store=useJournalViews();const icons={pinned:Pin,attachments:Paperclip,untagged:Tags};
  if(!store)return <JournalNavigator availableDates={dates} selectedDate={selectedDate} onSelectDate={onSelectDate}/>;
  return <div className="journal-navigation">
    <nav aria-label="日志快捷入口"><button onClick={()=>{store.reset();store.update({period:"all",layout:"list",ascending:false});onSelectDate("");}}><List size={16}/>全部日志</button><button onClick={()=>{store.update({layout:"stream",period:"month",recordFilter:"all",query:""});store.navigate(localJournalDate());onSelectDate(localJournalDate());}}><CalendarDays size={16}/>今天</button><button onClick={()=>{store.reset();onSelectDate(localJournalDate());}}><CalendarRange size={16}/>本月记录</button></nav>
    <div className="journal-nav-heading"><span>常用筛选</span></div>
    <nav className="journal-nav-filters" aria-label="日志常用筛选">{(["pinned","attachments","untagged"] as const).map(key=>{const Icon=icons[key];return <button key={key} aria-pressed={store.view.recordFilter===key} onClick={()=>onFilter(key)}><Icon size={16}/><span>{journalRecordFilters[key]}</span><small>{filterCounts[key]}</small></button>;})}</nav>
    <p className="journal-nav-hint">跨日期查找记录</p>
    <div className="journal-nav-calendar"><JournalNavigator availableDates={dates} selectedDate={store.anchor||store.view.day||(store.view.month===localJournalDate().slice(0,7)?localJournalDate():`${store.view.month}-01`)} onSelectDate={date=>{if(!date){store.update({period:"all",layout:"list"});}else{if(date.length===7)store.update({period:"month",month:date});store.navigate(date.length===7?`${date}-01`:date);}onSelectDate(date);}}/></div>
  </div>;
}
