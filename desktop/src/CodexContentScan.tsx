import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { CodexDefinitionModel } from "./CodexDefinitionModel";
import { publishCodexNotice, useCodexSuite } from "./CodexSuite";
import { useVisiblePolling } from "./useVisiblePolling";
import "./CodexContentScan.css";
type Run = { runId: string; status: string; stale: boolean; totalEntities: number; entitiesRead: number; charsRead: number; maxEntities: number; maxChars: number; counts: { recorded: number; unread: number; read: number } };
type Report = { run: Run; submitted: { proposalId: string; title: string; preview?: { stale: boolean; reviewBlocked: boolean; reviewBlockers: string[] }; previewError?: string }[]; unjudged: { title: string; reason: string }[]; errors: string[]; pauseReason: string; coverage: string; newEntitiesRead: number; newCharsRead: number };
export function CodexContentScan({tagId,runId,disabled=false,onCompleted,onRunningChange}:{tagId:string;runId?:string;disabled?:boolean;onCompleted?:()=>void;onRunningChange?:(busy:boolean)=>void}) {
  const suite=useCodexSuite();const {model,reasoningEffort:effort,fast}=suite.settings;
  const available=suite.loaded&&!suite.error;const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const [run,setRun]=useState<Run|null>(null),[report,setReport]=useState<Report|null>(null);
  const epoch=useRef(0),lock=useRef(false);
  const activeRun=useRef<{token:number;tagId:string;runId?:string}|null>(null);
  useVisiblePolling(async()=>{
    const operation=activeRun.current;if(!operation||operation.token!==epoch.current)return;
    const result=await invoke<{run:Run|null}>("tag_assignment",{args:{action:"scan_status",tag:operation.tagId,...(operation.runId?{runId:operation.runId}:{})}});
    if(epoch.current===operation.token&&activeRun.current===operation)setRun(result.run);
  },busy,5000,{initialDelayMs:5000});
  useEffect(()=>{if(error)publishCodexNotice(error,"error",6000);},[error]);
  useEffect(()=>{ const token=++epoch.current; setRun(null);setReport(null);setError("");
    void invoke<{run:Run|null}>("tag_assignment",{args:{action:"scan_status",tag:tagId,...(runId?{runId}:{})}}).then(v=>{if(epoch.current===token)setRun(v.run);}).catch(e=>{if(epoch.current===token)setError(String(e));});
    return()=>{epoch.current++;};
  },[tagId,runId]);
  useEffect(()=>{const refresh=()=>{if(lock.current)return;const token=epoch.current;void invoke<{run:Run|null}>("tag_assignment",{args:{action:"scan_status",tag:tagId,...(runId?{runId}:{})}}).then(v=>{if(epoch.current===token&&!lock.current)setRun(v.run);}).catch(()=>{});};window.addEventListener("hub-tag-scan-updated",refresh);return()=>window.removeEventListener("hub-tag-scan-updated",refresh);},[tagId,runId]);
  const start=async()=>{
    if(lock.current||disabled||!available)return;lock.current=true;setBusy(true);setError("");setReport(null);onRunningChange?.(true);publishCodexNotice("模型正在逐篇检查正文…","working",5000);
    const token=epoch.current;
    activeRun.current={token,tagId,runId};
    try {
      const result=await invoke<Report>("tag_assignment",{args:{action:"scan_generate",tag:tagId,...(runId?{runId}:{}),model,reasoningEffort:effort,fast}});
      if(epoch.current===token){setReport(result);setRun(result.run);}
      publishCodexNotice(result.errors.length?result.errors.join("；"):result.pauseReason||`逐篇检查已保存 ${result.submitted.length} 项判断`,result.errors.length||result.pauseReason?"warning":"success",6000);
      window.dispatchEvent(new Event("hub-tag-scan-updated"));
    }catch(e){if(epoch.current===token)setError(String(e));else publishCodexNotice(String(e),"error",6000);}
    finally{activeRun.current=null;lock.current=false;setBusy(false);onRunningChange?.(false);if(epoch.current===token)onCompleted?.();}
  };
  return <div className="tag-scan-codex">
    <div className="tag-scan-codex-toolbar"><CodexDefinitionModel />
      <button type="button" disabled={busy||disabled||!available||run?.stale||run?.status==="completed"} onClick={()=>void start()}>{busy?"模型正在逐篇检查…":run?.status==="completed"?"本轮清单已结束":run?"用模型 继续逐篇检查":"用模型 开始逐篇检查"}</button></div>
    <p>按已保存定义逐篇读取，进度自动保存。新任务默认 30 个实体、15,000 正文字符；达到上限后暂停。每次最多处理 30 项，建议由你审核。</p>
    {run&&<p aria-live="polite">已读 {run.entitiesRead} / {run.maxEntities} 个实体 · 正文 {run.charsRead.toLocaleString()} / {run.maxChars.toLocaleString()} 字符 · 已保存判断 {run.counts.recorded} 项</p>}
    {run?.stale&&<p>定义或范围已变化，请在“进度与预算”中确认新一轮检查。</p>}
    {run?.status==="completed"&&<p>本轮清单已结束；如需检查新增内容，可在“进度与预算”中创建新任务。</p>}
    {report&&<div className="tag-scan-codex-report"><strong>本次保存 {report.submitted.length} 项判断</strong><p>新读 {report.newEntitiesRead} 个实体 / {report.newCharsRead} 字符。结果已更新到下方内容补标区。</p>
      {report.pauseReason&&<p>{report.pauseReason}</p>}
      {!report.pauseReason&&report.run.status!=="completed"&&!report.errors.length&&<p>进度已保存，可点击继续。未判断的项目不算完成分析。</p>}
      {(!!report.submitted.length||!!report.unjudged.length)&&<details><summary>查看本次记录与未判断原因</summary>{report.submitted.map(v=><p key={v.proposalId}>{v.title}：{v.previewError?`已保存，预演失败：${v.previewError}`:v.preview?.stale?"证据已过期":v.preview?.reviewBlocked?`暂不能批准 · ${v.preview.reviewBlockers.join("；")}`:"待你审核"}</p>)}{report.unjudged.map((v,i)=><p key={i}>{v.title}：{v.reason}</p>)}</details>}
      <small>{report.coverage}</small></div>}
  </div>;
}
