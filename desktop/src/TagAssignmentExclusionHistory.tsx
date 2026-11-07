import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
type Page={tag:string;entityId:string;items:{id:number;reviewedAt:number;nextReviewAt:number}[];nextCursor:string|null};
export function TagAssignmentExclusionHistory({exclusionEventId}:{exclusionEventId:number}) {
  const [page,setPage]=useState<Page|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const lock=useRef(false),generation=useRef(0);
  useEffect(()=>()=>{generation.current++;},[]);
  async function load(cursor?:string){
    if(lock.current)return;lock.current=true;setBusy(true);setError("");const n=generation.current;
    try{
      const result=await invoke<Page>("tag_assignment",{args:{action:"exclusion_review_history",exclusionEventId,limit:20,...(cursor?{cursor}:{})}});
      if(n!==generation.current)return;
      setPage(old=>({...result,items:cursor&&old?[...old.items,...result.items.filter(i=>!old.items.some(x=>x.id===i.id))]:result.items}));
    }catch(e){if(n===generation.current)setError(String(e));}
    finally{if(n===generation.current){lock.current=false;setBusy(false);}}
  }
  return <details><summary>继续排除的复核历史</summary><p>仅显示此排除事件的历史决定，不代表当前排除状态。历史日期不是当前到期日，也不会自动取消排除。</p>
    <button type="button" disabled={busy} onClick={()=>void load()}>读取复核历史</button>
    {page&&<><p style={{overflowWrap:"anywhere"}}>#{page.tag} · {page.entityId} · 排除事件 {exclusionEventId}</p><ol>{page.items.map(i=><li key={i.id}>用户确认继续排除 · {new Date(i.reviewedAt*1000).toLocaleString("zh-CN")}<br/>当时设置的下次复核：{new Date(i.nextReviewAt*1000).toLocaleString("zh-CN")} · 记录 {i.id}</li>)}</ol>{!page.items.length&&<p>此排除事件暂无复核记录。</p>}{page.nextCursor&&<button type="button" disabled={busy} onClick={()=>void load(page.nextCursor!)}>加载更多复核历史</button>}<p>翻页保持首次读取的快照；查看最新记录请重新读取。</p></>}
    {busy&&<p role="status">正在读取复核历史…</p>}{error&&<p role="alert">{error}</p>}
  </details>;
}
