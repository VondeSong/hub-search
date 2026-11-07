import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
type Preview = { confirmationToken: string; change: { tag: string; entityId: string; nextReviewAt: number } };
export function TagAssignmentExclusionReview({ exclusionEventId, disabled, onChanged }: { exclusionEventId: number; disabled: boolean; onChanged: () => void }) {
  const [preview,setPreview]=useState<Preview|null>(null),[days,setDays]=useState(90),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const lock=useRef(false),generation=useRef(0);
  useEffect(()=>()=>{generation.current++;},[]);
  async function run(apply:boolean) {
    if(lock.current||disabled||(apply&&!preview))return;
    lock.current=true;setBusy(true);setError("");const n=generation.current;
    try {
      const result=await invoke<Preview>("tag_assignment",{args:{action:apply?"apply_exclusion_review":"preview_exclusion_review",exclusionEventId,...(apply&&preview?{nextReviewAt:preview.change.nextReviewAt,confirmationToken:preview.confirmationToken,requestId:`review-${preview.confirmationToken}`}:{reviewAfterDays:days})}});
      if(n!==generation.current)return;
      if(apply){setPreview(null);onChanged();}else setPreview(result);
    }catch(e){if(n===generation.current){setPreview(null);setError(`${String(e)}；请刷新后重新预览。`);}}
    finally{if(n===generation.current){lock.current=false;setBusy(false);}}
  }
  return <details><summary>复核并继续排除</summary><p>只记录复核决定。到期不自动取消排除、不启动扫描，也不修改来源标签。</p>
    <fieldset disabled={busy||disabled}>{!preview?<><label>下次复核<select value={days} onChange={e=>setDays(Number(e.target.value))}>{[30,90,180,365].map(d=><option key={d} value={d}>{d}天后</option>)}</select></label><button type="button" onClick={()=>void run(false)}>预览继续排除</button></>:<>
      <p style={{overflowWrap:"anywhere"}}>#{preview.change.tag} · {preview.change.entityId}<br/>排除事件：{exclusionEventId}<br/>下次复核：{new Date(preview.change.nextReviewAt*1000).toLocaleString("zh-CN")}</p>
      <button type="button" onClick={()=>void run(true)}>确认继续排除</button><button type="button" onClick={()=>setPreview(null)}>取消</button>
    </>}</fieldset>{busy&&<p role="status">正在核对复核记录…</p>}{error&&<p role="alert">{error}</p>}
  </details>;
}
