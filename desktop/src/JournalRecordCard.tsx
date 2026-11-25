import { Copy, ExternalLink, MoreHorizontal, Pin } from "lucide-react";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { journalDocumentKey, useJournalRecords } from "./JournalRecords";
import { journalEntryTitle } from "./JournalPresentation";
import { cleanSearchSnippet } from "./ResultExcerpt";
import type { SearchResult } from "./SearchTypes";

export function JournalRecordCard({entry,summary=true,source=true,onPreview,onOpen,selected=false,disabled=false,timeline=false}:{entry:SearchResult;summary?:boolean;source?:boolean;onPreview:(entry:SearchResult)=>void;onOpen?:(entry:SearchResult)=>void;selected?:boolean;disabled?:boolean;timeline?:boolean}){
 const records=useJournalRecords(),id=journalDocumentKey(entry.libraryId,entry.documentId),pinned=records.pins.has(id);
 const [message,setMessage]=useState(""),[full,setFull]=useState<string|null>(null),[expanded,setExpanded]=useState(false),[busy,setBusy]=useState(false);
 const read=()=>invoke<string>("local_document",{spaceId:entry.spaceId,documentId:entry.documentId,pageId:entry.provider==="craft"?entry.blockId??entry.documentId:undefined,resultId:entry.id});
 const copy=async()=>{setBusy(true);try{await navigator.clipboard.writeText(await read());setMessage("已复制正文");}catch(e){setMessage(`复制失败：${String(e)}`);}finally{setBusy(false);}};
 const expand=async()=>{if(expanded){setExpanded(false);return;}setBusy(true);try{setFull(await read());setExpanded(true);}catch(e){setMessage(`读取失败：${String(e)}`);}finally{setBusy(false);}};
 const title = journalEntryTitle(entry);
 const excerpt = timeline ? cleanSearchSnippet(entry.snippet).replace(/^\d{4}[-.]\d{2}[-.]\d{2}\s*/u,"").trim() : entry.snippet;
 return <article className={`journal-record-card memo-card ${selected?"is-selected":""}`}>
   <header>
     {timeline ? <><time>{entry.journalDate || entry.title}</time>{source&&<span className="journal-card-receipt applied"><i aria-hidden="true"/>{entry.libraryName} · 来源日志</span>}{pinned&&<span className="journal-card-pin">置顶</span>}</> :
       <span>{pinned&&<><Pin size={12}/>置顶 · </>}{entry.journalDate||entry.title}{source&&<small> · {entry.libraryName} · 来源日志</small>}</span>}
     <details className="journal-record-menu"><summary aria-label={`记录操作 ${title}`}><MoreHorizontal size={18}/></summary><div><button onClick={()=>records.togglePin(id)}><Pin size={14}/>{pinned?"取消置顶":"置顶"}</button><button disabled={busy||disabled} onClick={()=>void copy()}><Copy size={14}/>复制来源全文</button><button onClick={()=>onPreview(entry)}>在阅读面板打开</button>{onOpen&&<button onClick={()=>onOpen(entry)}><ExternalLink size={14}/>在来源中打开 / 编辑</button>}</div></details>
   </header>
   <button disabled={disabled} className={`journal-record-preview ${expanded?"is-expanded":""}`} aria-label={`预览日志：${title} · ${entry.libraryName}`} aria-pressed={selected} onClick={()=>onPreview(entry)}>
     {(timeline||!summary)&&<strong className={timeline?"journal-card-title":undefined}>{title}</strong>}
     {summary&&(!timeline||expanded||excerpt&&excerpt!==title)&&<p>{expanded?full:excerpt||"打开查看原文"}</p>}
   </button>
   {summary&&entry.snippet.length>350&&<button className="journal-record-expand" disabled={busy||disabled} aria-expanded={expanded} onClick={()=>void expand()}>{busy?"读取中…":expanded?"收起":"展开来源全文"}</button>}
   {message&&<small role="status">{message}</small>}
 </article>;
}
