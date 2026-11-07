import { CalendarDays, CalendarRange, List, Settings2 } from "lucide-react";
import { useState } from "react";
import { JournalNavigator } from "./JournalNavigator";
import { journalLayouts, localJournalDate, useJournalViews } from "./JournalViews";

export function JournalNavigation({dates,selectedDate,onSelectDate}:{dates:Array<{date:string;sources:number}>;selectedDate:string;onSelectDate:(date:string)=>void}){
  const store=useJournalViews();const [manage,setManage]=useState(false);
  if(!store)return <JournalNavigator availableDates={dates} selectedDate={selectedDate} onSelectDate={onSelectDate}/>;
  return <div className="journal-navigation">
    <nav aria-label="日志快捷入口"><button onClick={()=>{store.reset();store.update({period:"all",layout:"list",ascending:false});onSelectDate("");}}><List size={16}/>全部日志</button><button onClick={()=>{store.update({layout:"stream",period:"month"});store.navigate(localJournalDate());onSelectDate(localJournalDate());}}><CalendarDays size={16}/>今天</button><button onClick={()=>{store.reset();onSelectDate(localJournalDate());}}><CalendarRange size={16}/>本月记录</button></nav>
    <div className="journal-nav-heading"><span>我的视图</span><button aria-label="管理日志视图" aria-expanded={manage} onClick={()=>setManage(!manage)}><Settings2 size={14}/></button></div>
    {store.saved.filter(v=>manage||!v.hidden).map(v=><div key={v.id} className="journal-nav-saved"><button aria-pressed={store.activeId===v.id} onClick={()=>store.select(v.id)}><span>{v.name}<small>{journalLayouts[v.config.layout]}{v.hidden?" · 已隐藏":""}</small></span></button>{manage&&<><button aria-label={`上移 ${v.name}`} disabled={store.saved[0].id===v.id} onClick={()=>store.move(v.id,-1)}>↑</button><button aria-label={`下移 ${v.name}`} disabled={store.saved[store.saved.length-1]?.id===v.id} onClick={()=>store.move(v.id,1)}>↓</button><button aria-label={`${v.hidden?"显示":"隐藏"} ${v.name}`} onClick={()=>store.hide(v.id,!v.hidden)}>{v.hidden?"显示":"隐藏"}</button></>}</div>)}
    {!store.saved.length&&<p className="journal-nav-hint">在日志顶部点 ＋ 保存常用视图</p>}
    <div className="journal-nav-calendar"><JournalNavigator availableDates={dates} selectedDate={store.anchor||store.view.day||(store.view.month===localJournalDate().slice(0,7)?localJournalDate():`${store.view.month}-01`)} onSelectDate={date=>{if(!date){store.update({period:"all",layout:"list"});}else{store.navigate(date.length===7?`${date}-01`:date);}onSelectDate(date);}}/></div>
  </div>;
}
