import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NoteLocator } from "./AgentMaterials";
export type SourceSelection = { libraryId:string; directory:string; dateFrom?:string; dateTo?:string };
type Page = {snapshot:string;members:{locator:NoteLocator;title:string;path:string}[];totalMembers:number;nextCursor:string|null;dateCoverage:{unknownDateMembers:number;excludedByDateSelection:number}};
export function AgentSourceScope({libraryId,disabled,canConfirm,onConfirm,initialSelection,confirmationLabel="确认范围并建立对话（不启动分析）"}:{libraryId:string;disabled:boolean;canConfirm:boolean;initialSelection?:SourceSelection;confirmationLabel?:string;onConfirm:(selection:SourceSelection,manifest:string)=>Promise<void>}) {
 const [directory,setDirectory]=useState(initialSelection?.directory||"");const [from,setFrom]=useState(initialSelection?.dateFrom||"");const [to,setTo]=useState(initialSelection?.dateTo||"");
 const [page,setPage]=useState<Page|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [accepted,setAccepted]=useState(false);
 const request=useRef(0);useEffect(()=>()=>{request.current++;},[]);
 const selection:SourceSelection={libraryId,directory,...(from?{dateFrom:from}:{}),...(to?{dateTo:to}:{})};
 const change=(set:(s:string)=>void,value:string)=>{request.current++;set(value);setPage(null);setAccepted(false);setError("");};
 async function preview(next=false){
  if(busy||disabled)return;const seq=++request.current;setBusy(true);setError("");setAccepted(false);
  try {const value=await invoke<Page>("agent_investigation",{args:{action:"previewSourceScope",selection,...(next&&page?.nextCursor?{cursor:page.nextCursor}:{})}});if(seq!==request.current)return;if(next&&value.snapshot!==page?.snapshot)throw Error("范围已变化，请重新预览");setPage(value);}
  catch(e){if(seq===request.current){setPage(null);setError(String(e));}}
  finally{if(seq===request.current)setBusy(false);}
 }
 async function confirm(){if(!page||!accepted||!canConfirm||busy||disabled)return;setBusy(true);setError("");try{await onConfirm(selection,page.snapshot);}catch(e){setError(String(e));setAccepted(false);}finally{setBusy(false);}}
 return <details className="agent-materials"><summary>{initialSelection ? "重新确认固定范围" : "按目录和文件日期授权"}</summary><div>
  <p className="agent-note">仅限当前 Obsidian 资料库。预览只读本地清单；确认后固定全部匹配成员，不授权整库，新文件不会自动加入。日期只按 YYYY-MM-DD.md 文件名筛选，不代表正文中的事件日期。</p>
  <label>库内目录（留空为根目录）<input value={directory} disabled={busy||disabled} onChange={e=>change(setDirectory,e.target.value)}/></label>
  <label>文件日期从<input type="date" value={from} disabled={busy||disabled} onChange={e=>change(setFrom,e.target.value)}/></label>
  <label>文件日期到<input type="date" value={to} disabled={busy||disabled} onChange={e=>change(setTo,e.target.value)}/></label>
  <button type="button" disabled={busy||disabled} onClick={()=>void preview()}>预览材料范围</button>
  {error&&<p role="alert">{error}</p>}{busy&&<p role="status">正在核对材料范围…</p>}
  {page&&<><p>匹配 {page.totalMembers} 份，本页 {page.members.length} 份；目录中 {page.dateCoverage.unknownDateMembers} 份没有有效文件日期，按日期条件排除 {page.dateCoverage.excludedByDateSelection} 份。正文尚未读取，远端完整性未核对。</p>
  <ul>{page.members.map(m=><li key={JSON.stringify(m.locator)}>{m.title} · {m.path}</li>)}</ul>
  {page.nextCursor&&<button type="button" disabled={busy||disabled} onClick={()=>void preview(true)}>下一页范围</button>}
  <label><input type="checkbox" checked={accepted} disabled={busy||disabled} onChange={e=>setAccepted(e.target.checked)}/>授权这份清单中的全部 {page.totalMembers} 份材料</label>
  <button type="button" disabled={busy||disabled||!accepted||!canConfirm||!page.totalMembers} onClick={()=>void confirm()}>{confirmationLabel}</button>
  {!canConfirm&&<p>请先填写要查清的问题，再确认范围。</p>}</>}
 </div></details>;
}
