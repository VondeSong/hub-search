"use client";

import { useState } from "react";
import { Clock3, X } from "lucide-react";
import { sourceMeta, type HubItem } from "./data";
import "./recent-open.css";

export type RecentEntry = { id: string; openedAt?: number };

export function readRecentEntries(values: unknown[]): RecentEntry[] {
 const entries = new Map<string, RecentEntry>();
 for (const value of values) {
  const entry = typeof value === "string" ? {id:value} : value as Partial<RecentEntry> | null;
  if (!entry || typeof entry.id !== "string" || !entry.id || entries.has(entry.id)) continue;
  const openedAt = entry.openedAt;
  entries.set(entry.id, typeof openedAt === "number" && openedAt > 0 && Number.isFinite(new Date(openedAt).getTime()) ? {id:entry.id,openedAt} : {id:entry.id});
  if (entries.size === 30) break;
 }
 return [...entries.values()];
}

const openedTime = new Intl.DateTimeFormat("zh-CN", {month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit", hourCycle:"h23"});

export default function RecentOpen({entries,recording,onOpen,onRemove,onClear,onToggleRecording}: {
 entries: {item:HubItem; openedAt?:number}[];
 recording: boolean;
 onOpen: (item:HubItem)=>void;
 onRemove: (id:string)=>void;
 onClear: ()=>void;
 onToggleRecording: ()=>void;
}) {
 const [expanded,setExpanded] = useState(false);
 return <section className="recent-open" id="recent-open" aria-labelledby="recent-open-heading" onMouseDown={event=>event.preventDefault()}>
  <header><h2 id="recent-open-heading"><Clock3 size={15} aria-hidden="true"/>最近打开</h2>
   {entries.length>6&&<button type="button" aria-expanded={expanded} aria-controls="recent-open-list" onClick={()=>setExpanded(value=>!value)}>{expanded?"收起":"查看全部"}{!expanded&&" · "+entries.length}</button>}
  </header>
  {entries.length ? <ul id="recent-open-list">
   {(expanded?entries:entries.slice(0,6)).map(({item,openedAt})=><li key={item.id}>
    <button type="button" className="recent-open-item" onClick={()=>onOpen(item)}>
     <strong title={item.title}>{item.title}</strong>
     <small><span>{sourceMeta[item.source].name} · {item.space}</span>{openedAt&&<time dateTime={new Date(openedAt).toISOString()} title={"打开于 "+openedTime.format(openedAt)}>{openedTime.format(openedAt)}</time>}</small>
    </button>
    <button type="button" className="recent-open-remove" title="移除记录" aria-label={"移除记录："+item.title} onClick={()=>onRemove(item.id)}><X size={15}/></button>
   </li>)}
  </ul> : <p>{recording?"打开过的资料会出现在这里。":"没有保留的记录。"}</p>}
  <footer><span>{recording?"仅在当前浏览器记录":"已暂停记录"}</span>
   <button type="button" onClick={onToggleRecording}>{recording?"暂停记录":"继续记录"}</button>
   {entries.length>0&&<button type="button" onClick={onClear}>清空</button>}
  </footer>
 </section>;
}
