import { Pencil, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { QuickJournal } from "./QuickJournal";
import { userProfileStorage } from "./UserProfileStorage";
import type { JournalViewConfig } from "./JournalViews";
import type { LibrarySummary } from "./SearchTypes";

const KEY="hub.journal.calendar-drafts.v1";
function readDays(){try{const value=JSON.parse(userProfileStorage.getItem(KEY)||"[]");return Array.isArray(value)?value.filter((day):day is string=>typeof day==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(day)):[];}catch{return [];}}
export function JournalCapturePanel({libraries,day,onDay,dataVersion,scope,view}:{libraries:LibrarySummary[];day:string;onDay:(day:string)=>void;dataVersion:string;scope:string[]|null;view:JournalViewConfig}){
 const [days,setDays]=useState(readDays),[error,setError]=useState(""),[notice,setNotice]=useState("");const panel=useRef<HTMLElement>(null),activeDay=useRef(day),currentDays=useRef(days);activeDay.current=day;currentDays.current=days;
 const remember=(next:string[])=>{try{userProfileStorage.setItem(KEY,JSON.stringify(next));setDays(next);}catch(e){setError(`草稿入口保存失败：${String(e)}`);}};
 useEffect(()=>{if(day&&!days.includes(day))remember([...days,day]);},[day]);
 useEffect(()=>{if(!day)return;const outside=(event:PointerEvent)=>{if(panel.current?.contains(event.target as Node)||(event.target as HTMLElement).closest(".journal-draft-dock,.journal-daily-add,[aria-label='新建日志']"))return;onDay("");};document.addEventListener("pointerdown",outside);return()=>document.removeEventListener("pointerdown",outside);},[day,onDay]);
 return <>{error&&<p role="alert">{error}</p>}{notice&&<div className="journal-capture-notice" role="status">{notice}<button type="button" aria-label="关闭日志保存提示" onClick={()=>setNotice("")}><X size={14}/></button></div>}{day&&<section ref={panel} className="journal-floating-editor" data-hub-keyboard-scope="journal-capture" role="region" aria-label="新建日志" onBlur={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget as Node))onDay("");}} onKeyDown={event=>{if(event.key==="Escape"&&!event.nativeEvent.isComposing&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();onDay("");}}}><header><div><h2>新建日志</h2><time>{day}</time></div><button type="button" aria-label="收起日志草稿" onClick={()=>onDay("")}><X size={18}/></button></header><QuickJournal key={day} mode="calendar" captureDate={day} libraries={libraries} scope={scope} view={view} dataVersion={dataVersion} onSaved={saved=>{setNotice(saved.notice+((view.query||view.libraries!==null||(view.recordFilter&&view.recordFilter!=="all"))?" 当前有筛选；若未显示，可调整筛选查看。":""));remember(currentDays.current.filter(value=>value!==day));if(activeDay.current===day)onDay("");}}/></section>}
 <div className="journal-draft-dock" aria-label="日志草稿">{days.filter(value=>value!==day).map(value=><button type="button" key={value} onClick={()=>onDay(value)} aria-label={`继续编辑 ${value} 的日志草稿`}><Pencil size={14}/>{Number(value.slice(5,7))}月{Number(value.slice(8))}日 · 继续编辑</button>)}</div></>;
}
