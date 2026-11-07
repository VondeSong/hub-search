import { subscribeUserProfileStorage, userProfileStorage } from "./UserProfileStorage";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { isWindowVisible, subscribeWindowVisibility } from "./WindowVisibility";
type Due={count:number;hasMore:boolean;asOf:number};
const globalPreferenceKey="hub.exclusion-review-global-reminder.v1";
export function useExclusionReviewReminder({tagId,days,revision,global=false,active=true}:{tagId?:string;days:number;revision:number;global?:boolean;active?:boolean}) {
  const [due,setDue]=useState<Due|null>(null),[error,setError]=useState(""),[enabled,setEnabled]=useState(()=>{if(!global)return true;try{return userProfileStorage.getItem(globalPreferenceKey)==="enabled";}catch{return false;}}),[retry,setRetry]=useState(0),[storageError,setStorageError]=useState("");
  const changeEnabled=(value:boolean)=>{setEnabled(value);if(global){try{userProfileStorage.setItem(globalPreferenceKey,value?"enabled":"disabled");setStorageError("");}catch{setStorageError("提醒设置未能保存，仅本次生效。");}}};
  useEffect(()=>{if(!global)return;return subscribeUserProfileStorage(()=>setEnabled(userProfileStorage.getItem(globalPreferenceKey)==="enabled"));},[global]);
  const surface=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!enabled||!active)return;
    let alive=true,loading=false,lastAttempt=0,visible=global||typeof IntersectionObserver==="undefined";
    setDue(null);setError("");
    async function check(){
      if(!alive||!visible||loading||!isWindowVisible()||Date.now()-lastAttempt<60000)return;
      loading=true;lastAttempt=Date.now();
      try{
        const result=await invoke<Due>("tag_assignment",{args:{action:"exclusion_review_due",tag:tagId??"",olderThanDays:days}});
        if(alive){setDue(result);setError("");}
      }catch(e){if(alive){setDue(null);setError(String(e));}}
      finally{loading=false;}
    }
    const observer=!global&&typeof IntersectionObserver!=="undefined"?new IntersectionObserver(entries=>{visible=entries.some(e=>e.isIntersecting);if(visible)void check();}):null;
    if(surface.current)observer?.observe(surface.current);
    let timer=0;
    const wake=()=>{window.clearInterval(timer);if(isWindowVisible()){void check();timer=window.setInterval(()=>void check(),300000);}};
    const unsubscribe=subscribeWindowVisibility(wake);wake();window.addEventListener("focus",wake);
    return()=>{alive=false;observer?.disconnect();window.clearInterval(timer);unsubscribe();window.removeEventListener("focus",wake);};
  },[tagId,days,revision,enabled,retry,global,active]);
  return {due,error,enabled,changeEnabled,storageError,surface,retry:()=>setRetry(n=>n+1)};
}

export function TagAssignmentExclusionReminder({tagId,days,revision,onOpen,global=false}:{tagId?:string;days:number;revision:number;onOpen:()=>void;global?:boolean}) {
  const {due,error,enabled,changeEnabled,storageError,surface,retry}=useExclusionReviewReminder({tagId,days,revision,global});
  return <div ref={surface} className={global ? "tag-assignment-hint" : "tag-exclusion-reminder"}>
    {!global&&<header><strong>复核提醒</strong><span>定期回看暂不补标的内容</span></header>}
    <label><input type="checkbox" checked={enabled} onChange={e=>changeEnabled(e.target.checked)}/>{global?"跨页面复核提醒":"本页到期复核提醒"}</label>
    {enabled&&due&&<div className={`tag-exclusion-due ${due.count>0?"has-due":"clear"}`}><strong>{due.count>0?`有 ${due.count}${due.hasMore?"+":""} 条排除待复核`:"当前范围暂无待复核排除"}</strong><small>上次检查 {new Date(due.asOf*1000).toLocaleTimeString("zh-CN")}</small>{due.count>0&&<button type="button" onClick={onOpen}>{global?"前往标签治理":"打开待复核清单"}</button>}</div>}
    {!global&&!enabled&&<p className="tag-exclusion-placeholder">提醒已关闭，可在排除清单中手动查看。</p>}
    {enabled&&error&&<p>复核提醒暂不可用，不代表没有待复核项。<button type="button" onClick={retry}>重试复核提醒</button></p>}
    {storageError&&<p role="alert">{storageError}</p>}
    <p className="tag-exclusion-scope">{tagId?`#${tagId}`:"全部标签"} · 未复核且启用至少 {days} 天，或已到复核日期</p>
    <details><summary>了解提醒规则</summary>
      <p>{global?"应用窗口显示时每 5 分钟检查一次，切换页面不中断。":"本页可见时每 5 分钟检查一次，关闭页面后停止。"}返回时最多每分钟补查一次。</p>
      <p>已复核记录按下次复核日期筛选。提醒仅在应用内显示，不会自动取消排除。</p>
      {global&&<p>开关保存在当前资料库，可随完整备份迁移。</p>}
    </details>
  </div>;
}
