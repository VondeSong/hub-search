import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { TagAssignmentExclusion } from "./TagAssignmentExclusion";
import { TagAssignmentExclusionReview } from "./TagAssignmentExclusionReview";
import { TagAssignmentExclusionHistory } from "./TagAssignmentExclusionHistory";
import { TagAssignmentExclusionReminder } from "./TagAssignmentExclusionReminder";
type Mode = "active" | "history" | "review";
type Page = { items: { id: number; tag: string; entityId: string; proposalId: string; excluded: boolean; createdAt: number; proposalTitle: string; canManage: boolean; lastReviewedAt?: number; nextReviewAt?: number }[]; nextCursor: string | null; snapshotVersion: number; mode: Mode };
export function TagAssignmentExclusionList({ tagId, onChanged }: { tagId?: string; onChanged: () => void }) {
  const [page,setPage]=useState<Page|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [days,setDays]=useState(90);
  const [revision,setRevision]=useState(0);const details=useRef<HTMLDetailsElement>(null);
  const changed=()=>{setRevision(n=>n+1);onChanged();};
  const lock=useRef(false),generation=useRef(0);
  useEffect(()=>()=>{generation.current++;},[]);
  async function load(mode:Mode,cursor?:string) {
    if(lock.current)return;lock.current=true;setBusy(true);setError("");const n=generation.current;
    try {
      const result=await invoke<Page>("tag_assignment",{args:{action:"list_exclusions",tag:tagId??"",mode,limit:20,...(mode==="review"?{olderThanDays:days}:{}),...(cursor?{cursor}:{})}});
      if(n!==generation.current)return;
      setPage(old=>({...result,items:cursor&&old?[...old.items,...result.items.filter(i=>!old.items.some(p=>p.id===i.id))]:result.items}));
    }catch(e){if(n===generation.current)setError(String(e));}
    finally{if(n===generation.current){lock.current=false;setBusy(false);}}
  }
  return <div className="tag-exclusion-management-grid"><TagAssignmentExclusionReminder tagId={tagId} days={days} revision={revision} onOpen={()=>{if(details.current)details.current.open=true;void load("review");}}/><details ref={details} className="tag-exclusion-browser"><summary><span><strong>排除清单</strong><small>查看当前排除、待复核内容及操作历史</small></span></summary>
    <div className="tag-exclusion-browser-body">
    <p className="tag-exclusion-scope">范围：{tagId ? `#${tagId}` : "全部标签"} · 内容补标排除</p>
    <fieldset disabled={busy} className="tag-exclusion-controls">
      <div className="tag-exclusion-tabs" role="group" aria-label="排除记录分类">
      <button type="button" aria-pressed={page?.mode==="active"} onClick={()=>void load("active")}>查看当前排除</button>
      <button type="button" aria-pressed={page?.mode==="review"} onClick={()=>void load("review")}>查看待复核排除</button>
      <button type="button" aria-pressed={page?.mode==="history"} onClick={()=>void load("history")}>查看操作历史</button>
      </div>
      <div className="tag-exclusion-filter"><label>未复核记录的启用时长<select value={days} onChange={e=>{setDays(Number(e.target.value));setPage(null);setError("");}}><option value={30}>至少30天</option><option value={90}>至少90天</option><option value={180}>至少180天</option><option value={365}>至少365天</option></select></label><small>用于待复核清单与到期提醒</small></div>
      {page&&<>
        <p>{page.mode==="review"?`复核到期或未复核且启用至少${days}天的排除（加载时快照）`:page.mode==="active"?"当前排除清单（加载时快照）":"操作历史（事件发生时的动作，非当前状态）"} · 已加载 {page.items.length} 条</p>
        {page.mode==="review"&&<p>已复核的排除按下次复核日期筛选；未复核的按最近一次启用时长筛选，未知时间不纳入。到期不会自动撤销、重新分析或提交建议。</p>}
        <ul>{page.items.map(i=><li key={`${page.mode}:${page.snapshotVersion}:${i.id}`}>
          <p>{i.proposalTitle||"原建议标题不可用"} · #{i.tag} · {i.excluded?"启用持续排除":"撤销持续排除"} · {new Date(i.createdAt*1000).toLocaleString("zh-CN")}</p>
          <details><summary>查看精确定位</summary><p style={{overflowWrap:"anywhere"}}>实体：{i.entityId}<br/>来源建议：{i.proposalId}<br/>事件编号：{i.id}</p><p>标题取自原建议，不是当前正文标题或事件时标题快照。</p></details>
          <TagAssignmentExclusionHistory exclusionEventId={i.id}/>
          {page.mode!=="history"&&<>
            {i.nextReviewAt&&<p>上次复核：{i.lastReviewedAt?new Date(i.lastReviewedAt*1000).toLocaleString("zh-CN"):"未知"} · 下次复核：{new Date(i.nextReviewAt*1000).toLocaleString("zh-CN")}</p>}
            <TagAssignmentExclusionReview exclusionEventId={i.id} disabled={busy} onChanged={()=>{changed();void load(page.mode);}}/>
            {!i.canManage&&<p>来源建议缺失或状态不匹配；可按排除事件中的精确标签和实体核对撤销，不重建来源建议。</p>}
            <TagAssignmentExclusion exclusionEventId={i.id} excluded={true} disabled={busy} onChanged={()=>{changed();void load(page.mode);}}/>
          </>}
        </li>)}</ul>
        {!page.items.length&&<p>此范围暂无{page.mode==="review"?"待复核排除":page.mode==="active"?"已启用排除":"操作记录"}。</p>}
        {page.nextCursor&&<button type="button" onClick={()=>void load(page.mode,page.nextCursor!)}>加载更多排除记录</button>}
        <p>翻页沿用事件快照；其他窗口可能已修改偏好，请重新查看以刷新。撤销前仍会重新校验。</p>
      </>}
    </fieldset>
    {!page&&<p className="tag-exclusion-placeholder">选择上方分类，查看对应记录。</p>}
    {busy&&<p role="status">正在读取排除记录…</p>}{error&&<p role="alert">{error}</p>}
    <details className="tag-exclusion-rules"><summary>管理规则</summary><p>撤销排除不恢复旧审核决定，也不会自动启动扫描。</p></details>
    </div>
  </details></div>;
}
